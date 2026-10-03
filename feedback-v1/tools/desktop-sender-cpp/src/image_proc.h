#pragma once

#include <vector>
#include <cstdint>
#include <cmath>
#include <algorithm>

#ifdef FEEDBACK_QT_AVAILABLE
#include <QImage>
#endif

namespace feedback {

struct RawImage {
    int width = 0;
    int height = 0;
    int channels = 1; // 1 for grayscale, 3 for RGB, 4 for RGBA
    std::vector<uint8_t> data;

    bool is_valid() const {
        return width > 0 && height > 0 && !data.empty() && data.size() >= static_cast<size_t>(width * height * channels);
    }
};

/// 转灰度图，消除 ClearType 边缘彩斑
RawImage to_grayscale(const RawImage& src);

/// 水印消解：企微倾斜防泄密水印亮度 > 205 归一化为纯白底色 (255)
RawImage remove_watermark(const RawImage& gray, uint8_t threshold = 205);

/// 双三次插值 (Bicubic) 放大 2 倍，强化小字笔画
RawImage resize_bicubic_2x(const RawImage& gray);

/// 完整的下拉框图像预处理管线
RawImage preprocess_dropdown_image(const RawImage& src);

#ifdef FEEDBACK_QT_AVAILABLE
QImage raw_to_qimage(const RawImage& raw);
RawImage qimage_to_raw(const QImage& qimg);
#endif

} // namespace feedback
