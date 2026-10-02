use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::imageops::{resize, FilterType};
use image::{DynamicImage, GrayImage, ImageEncoder, Luma};
use std::io::Cursor;

/// 图像前置预处理管线：
/// 1. 转灰度图消除 ClearType 边缘彩斑杂色；
/// 2. 水印擦除：将企微背景微弱倾斜防泄密水印（灰度通常 > 205）归一化为纯白底色（255），保留文字核心笔画；
/// 3. 双三次插值放大 2 倍，强化 12px~14px 小字笔画特征。
pub fn preprocess_dropdown_image(img: &DynamicImage) -> DynamicImage {
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();

    // 像素级阈值化与去水印
    let mut cleaned = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let px = gray.get_pixel(x, y)[0];
            let new_px = if px > 205 { 255 } else { px };
            cleaned.put_pixel(x, y, Luma([new_px]));
        }
    }

    // 双三次插值放大 2 倍
    let scaled = resize(&cleaned, w * 2, h * 2, FilterType::CatmullRom);
    DynamicImage::ImageLuma8(scaled)
}

/// 将图像编码为 base64 JPEG 字符串，便于传输至云端视觉 API
pub fn image_to_base64_jpeg(img: &DynamicImage, quality: u8) -> Result<String, image::ImageError> {
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    let rgb = img.to_rgb8();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
    encoder.write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(BASE64_STANDARD.encode(buf))
}
