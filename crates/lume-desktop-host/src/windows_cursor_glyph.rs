const SOURCE_SIZE: usize = 252;
const LOGICAL_SIZE: usize = 126;
const CHANNELS: usize = 4;
const REFERENCE_CURSOR_BGRA: &[u8] =
    include_bytes!("../assets/official-software-cursor-window-252.bgra");

pub fn reference_cursor_metrics() -> (usize, usize, usize) {
    (SOURCE_SIZE, SOURCE_SIZE, REFERENCE_CURSOR_BGRA.len())
}

pub fn cursor_physical_size_for_dpi(dpi: u32) -> usize {
    if dpi == 0 {
        return LOGICAL_SIZE;
    }
    (LOGICAL_SIZE * dpi as usize + 48) / 96
}

pub fn render_reference_cursor_frame_at_size(
    output_size: usize,
    rotation: f64,
    click_progress: f64,
) -> Vec<u8> {
    let output_size = output_size.max(1);
    let mut output = vec![0_u8; output_size * output_size * CHANNELS];
    let pulse = click_progress.clamp(0.0, 1.0);
    let scale_x = 1.0 - pulse * 0.03;
    let scale_y = 1.0 + pulse * 0.012;
    let cosine = rotation.cos();
    let sine = rotation.sin();
    let output_center = (output_size as f64 - 1.0) * 0.5;
    let source_center = (SOURCE_SIZE as f64 - 1.0) * 0.5;
    let source_scale = SOURCE_SIZE as f64 / output_size as f64;

    for y in 0..output_size {
        for x in 0..output_size {
            let output_x = x as f64 - output_center;
            let output_y = y as f64 - output_center;
            let rotated_x = cosine * output_x + sine * output_y;
            let rotated_y = -sine * output_x + cosine * output_y;
            let source_x = source_center + (rotated_x / scale_x) * source_scale;
            let source_y = source_center + (rotated_y / scale_y) * source_scale;
            let pixel = sample_bilinear(source_x, source_y);
            let offset = (y * output_size + x) * CHANNELS;
            output[offset..offset + CHANNELS].copy_from_slice(&pixel);
        }
    }
    output
}

fn sample_bilinear(x: f64, y: f64) -> [u8; CHANNELS] {
    if x < 0.0 || y < 0.0 || x > (SOURCE_SIZE - 1) as f64 || y > (SOURCE_SIZE - 1) as f64 {
        return [0; CHANNELS];
    }
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(SOURCE_SIZE - 1);
    let y1 = (y0 + 1).min(SOURCE_SIZE - 1);
    let weight_x = x - x0 as f64;
    let weight_y = y - y0 as f64;
    let mut result = [0_u8; CHANNELS];
    for (channel, value) in result.iter_mut().enumerate() {
        let top = channel_value(x0, y0, channel) * (1.0 - weight_x)
            + channel_value(x1, y0, channel) * weight_x;
        let bottom = channel_value(x0, y1, channel) * (1.0 - weight_x)
            + channel_value(x1, y1, channel) * weight_x;
        *value = (top * (1.0 - weight_y) + bottom * weight_y).round() as u8;
    }
    result
}

fn channel_value(x: usize, y: usize, channel: usize) -> f64 {
    f64::from(REFERENCE_CURSOR_BGRA[(y * SOURCE_SIZE + x) * CHANNELS + channel])
}
