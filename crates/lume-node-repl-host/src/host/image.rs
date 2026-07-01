use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use tokio::fs;
use uuid::Uuid;

use crate::protocol::ExecutionImage;

#[derive(Debug, Clone)]
pub struct ImageStore {
    root: PathBuf,
}

impl ImageStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub async fn save(&self, image_url: &str) -> Result<ExecutionImage> {
        if let Some((mime_type, encoded)) = parse_data_url(image_url) {
            let bytes = STANDARD.decode(encoded).context("decode image data URL")?;
            let mime_type = normalize_mime(mime_type, &bytes)?;
            let extension = extension_for(&mime_type);
            fs::create_dir_all(&self.root)
                .await
                .context("create image artifact directory")?;
            let file_path = self.root.join(format!("{}.{}", Uuid::new_v4(), extension));
            fs::write(&file_path, &bytes)
                .await
                .context("write image artifact")?;
            return Ok(ExecutionImage {
                data_base64: Some(STANDARD.encode(&bytes)),
                mime_type: Some(mime_type),
                file_path: Some(file_path.to_string_lossy().into_owned()),
            });
        }

        let path = Path::new(image_url);
        if path.is_absolute() {
            let bytes = fs::read(path)
                .await
                .with_context(|| format!("read image {}", path.display()))?;
            let mime_type =
                sniff_mime(&bytes).ok_or_else(|| anyhow!("unsupported image format"))?;
            return Ok(ExecutionImage {
                data_base64: Some(STANDARD.encode(&bytes)),
                mime_type: Some(mime_type.to_string()),
                file_path: Some(path.to_string_lossy().into_owned()),
            });
        }

        Err(anyhow!(
            "emitImage expects a data URL or absolute image path"
        ))
    }
}

fn parse_data_url(value: &str) -> Option<(&str, &str)> {
    let rest = value.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?;
    Some((mime, data))
}

fn normalize_mime(declared: &str, bytes: &[u8]) -> Result<String> {
    let sniffed = sniff_mime(bytes).ok_or_else(|| anyhow!("unsupported image format"))?;
    if !declared.is_empty() && declared != sniffed {
        return Err(anyhow!("image MIME type does not match encoded bytes"));
    }
    Ok(sniffed.to_string())
}

fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_mime, parse_data_url, sniff_mime};

    #[test]
    fn parses_and_sniffs_supported_images() {
        assert_eq!(
            parse_data_url("data:image/png;base64,AAAA"),
            Some(("image/png", "AAAA"))
        );
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff_mime(&[0xff, 0xd8, 0xff, 0x00]), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"RIFFxxxxWEBPrest"), Some("image/webp"));
    }

    #[test]
    fn rejects_declared_mime_mismatch() {
        let error = normalize_mime("image/jpeg", b"\x89PNG\r\n\x1a\nrest")
            .unwrap_err()
            .to_string();
        assert!(error.contains("does not match"));
    }
}
