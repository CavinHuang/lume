use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

/// NDJSON file writer with daily rotation and size-based sequencing.
#[derive(Debug)]
pub struct NdjsonWriter {
    logs_dir: PathBuf,
    max_file_size_bytes: u64,
    retention_days: u32,
    current_date: String,
    current_sequence: u32,
    current_file: Option<BufWriter<File>>,
    current_size: u64,
}

impl NdjsonWriter {
    pub fn new(logs_dir: PathBuf, max_file_size_mb: u32, retention_days: u32) -> Self {
        let _ = fs::create_dir_all(&logs_dir);
        let writer = Self {
            logs_dir,
            max_file_size_bytes: max_file_size_mb as u64 * 1_000_000,
            retention_days,
            current_date: String::new(),
            current_sequence: 0,
            current_file: None,
            current_size: 0,
        };
        writer.cleanup_old_files();
        writer
    }

    /// Write a single NDJSON line. Handles date rollover and size limits.
    pub fn write_line(&mut self, line: &str) {
        let today = today_date_str();

        // Date changed — close current file, reset sequence.
        if self.current_date != today {
            self.flush();
            self.current_file = None;
            self.current_date = today;
            self.current_sequence = 0;
            self.current_size = 0;
        }

        // No open file — find or create one.
        if self.current_file.is_none() {
            self.open_current_file();
        }

        if let Some(ref mut file) = self.current_file {
            let bytes = line.as_bytes();
            let _ = file.write_all(bytes);
            let _ = file.write_all(b"\n");
            self.current_size += bytes.len() as u64 + 1;

            // Size limit exceeded — close so next write opens a new sequence.
            if self.current_size >= self.max_file_size_bytes {
                self.flush();
                self.current_file = None;
                self.current_sequence += 1;
                self.current_size = 0;
            }
        }
    }

    pub fn flush(&mut self) {
        if let Some(ref mut file) = self.current_file {
            let _ = file.flush();
        }
    }

    /// Open the current date's file. If base file is at max size, find next sequence.
    fn open_current_file(&mut self) {
        let base_path = self.file_path(0);

        // If base file is under size limit, append to it.
        if let Ok(meta) = fs::metadata(&base_path) {
            if meta.len() < self.max_file_size_bytes {
                self.current_sequence = 0;
                self.current_size = meta.len();
                self.current_file = Self::open_append(&base_path);
                return;
            }

            // Base file full — find next available sequence.
            let mut seq = 1u32;
            loop {
                let path = self.file_path(seq);
                if let Ok(meta) = fs::metadata(&path) {
                    if meta.len() < self.max_file_size_bytes {
                        self.current_sequence = seq;
                        self.current_size = meta.len();
                        self.current_file = Self::open_append(&path);
                        return;
                    }
                    seq += 1;
                } else {
                    break;
                }
            }
            self.current_sequence = seq;
            self.current_size = 0;
            self.current_file = Self::open_append(&self.file_path(seq));
        } else {
            // No file yet — create it.
            self.current_sequence = 0;
            self.current_size = 0;
            self.current_file = Self::open_append(&base_path);
        }
    }

    fn file_path(&self, sequence: u32) -> PathBuf {
        if sequence == 0 {
            self.logs_dir.join(format!("lume-{}.ndjson", self.current_date))
        } else {
            self.logs_dir.join(format!("lume-{}.{}.ndjson", self.current_date, sequence))
        }
    }

    fn open_append(path: &Path) -> Option<BufWriter<File>> {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
            .map(BufWriter::new)
    }

    /// Delete log files older than `retention_days`.
    fn cleanup_old_files(&self) {
        if self.retention_days == 0 {
            return;
        }
        let cutoff = chrono::Local::now()
            .date_naive()
            - chrono::Duration::days(self.retention_days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%d").to_string();

        let Ok(entries) = fs::read_dir(&self.logs_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.starts_with("lume-") || !name_str.ends_with(".ndjson") {
                continue;
            }
            // Extract date from filename: lume-YYYY-MM-DD.ndjson or lume-YYYY-MM-DD.N.ndjson
            let date_part = name_str
                .strip_prefix("lume-")
                .unwrap_or("")
                .split('.')
                .next()
                .unwrap_or("");
            if date_part < cutoff_str.as_str() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

fn today_date_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

impl Drop for NdjsonWriter {
    fn drop(&mut self) {
        self.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn write_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = NdjsonWriter::new(
            dir.path().to_path_buf(),
            20,
            14,
        );
        writer.write_line(r#"{"ts":"2026-06-09T08:00:00Z","level":"info","message":"hello"}"#);
        writer.flush();

        let files: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with(".ndjson"));
    }

    #[test]
    fn write_multiple_lines() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = NdjsonWriter::new(dir.path().to_path_buf(), 20, 14);

        for i in 0..5 {
            writer.write_line(&format!(r#"{{"i":{}}}"#, i));
        }
        writer.flush();

        // Read back and count lines
        let entries: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1);

        let mut contents = String::new();
        File::open(entries[0].path())
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        assert_eq!(contents.lines().count(), 5);
    }

    #[test]
    fn size_rotation() {
        let dir = tempfile::tempdir().unwrap();
        // Very small limit to trigger rotation quickly
        let mut writer = NdjsonWriter::new(dir.path().to_path_buf(), 0, 14);

        // Each line is ~30 bytes, so 2 lines should fill and rotate
        for i in 0..5 {
            writer.write_line(&format!(r#"{{"line":{}}}"#, i));
        }
        writer.flush();

        let files: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(files.len() > 1, "Expected multiple files due to rotation, got: {:?}", files);
    }
}
