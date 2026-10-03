#include "image_proc.h"

namespace feedback {

RawImage to_grayscale(const RawImage& src) {
    if (!src.is_valid()) return {};
    if (src.channels == 1) return src;

    RawImage out;
    out.width = src.width;
    out.height = src.height;
    out.channels = 1;
    out.data.resize(src.width * src.height);

    for (int i = 0; i < src.width * src.height; ++i) {
        int r = src.data[i * src.channels + 0];
        int g = src.data[i * src.channels + 1];
        int b = src.data[i * src.channels + 2];
        // Standard Rec. 601 luma formula
        out.data[i] = static_cast<uint8_t>((r * 299 + g * 587 + b * 114) / 1000);
    }
    return out;
}

RawImage remove_watermark(const RawImage& gray, uint8_t threshold) {
    if (!gray.is_valid() || gray.channels != 1) return gray;

    RawImage out = gray;
    for (auto& px : out.data) {
        if (px > threshold) {
            px = 255;
        }
    }
    return out;
}

static inline double cubic_weight(double x) {
    // Catmull-Rom spline with a = -0.5
    const double a = -0.5;
    x = std::fabs(x);
    if (x <= 1.0) {
        return (a + 2.0) * x * x * x - (a + 3.0) * x * x + 1.0;
    } else if (x < 2.0) {
        return a * x * x * x - 5.0 * a * x * x + 8.0 * a * x - 4.0 * a;
    }
    return 0.0;
}

RawImage resize_bicubic_2x(const RawImage& gray) {
    if (!gray.is_valid() || gray.channels != 1) return gray;

    int new_w = gray.width * 2;
    int new_h = gray.height * 2;

    RawImage out;
    out.width = new_w;
    out.height = new_h;
    out.channels = 1;
    out.data.resize(new_w * new_h);

    auto get_pixel = [&](int x, int y) -> uint8_t {
        x = std::clamp(x, 0, gray.width - 1);
        y = std::clamp(y, 0, gray.height - 1);
        return gray.data[y * gray.width + x];
    };

    for (int y = 0; y < new_h; ++y) {
        double src_y = (y + 0.5) / 2.0 - 0.5;
        int y_int = static_cast<int>(std::floor(src_y));
        double y_frac = src_y - y_int;

        double wy[4];
        for (int m = -1; m <= 2; ++m) {
            wy[m + 1] = cubic_weight(y_frac - m);
        }

        for (int x = 0; x < new_w; ++x) {
            double src_x = (x + 0.5) / 2.0 - 0.5;
            int x_int = static_cast<int>(std::floor(src_x));
            double x_frac = src_x - x_int;

            double wx[4];
            for (int n = -1; n <= 2; ++n) {
                wx[n + 1] = cubic_weight(x_frac - n);
            }

            double sum = 0.0;
            double total_w = 0.0;
            for (int m = -1; m <= 2; ++m) {
                for (int n = -1; n <= 2; ++n) {
                    double w = wy[m + 1] * wx[n + 1];
                    sum += get_pixel(x_int + n, y_int + m) * w;
                    total_w += w;
                }
            }

            if (total_w != 0.0) sum /= total_w;
            out.data[y * new_w + x] = static_cast<uint8_t>(std::clamp(std::round(sum), 0.0, 255.0));
        }
    }

    return out;
}

RawImage preprocess_dropdown_image(const RawImage& src) {
    RawImage gray = to_grayscale(src);
    RawImage cleaned = remove_watermark(gray, 205);
    return resize_bicubic_2x(cleaned);
}

#ifdef FEEDBACK_QT_AVAILABLE
QImage raw_to_qimage(const RawImage& raw) {
    if (!raw.is_valid()) return {};
    if (raw.channels == 1) {
        QImage qimg(raw.data.data(), raw.width, raw.height, raw.width, QImage::Format_Grayscale8);
        return qimg.copy();
    } else if (raw.channels == 3) {
        QImage qimg(raw.data.data(), raw.width, raw.height, raw.width * 3, QImage::Format_RGB888);
        return qimg.copy();
    } else if (raw.channels == 4) {
        QImage qimg(raw.data.data(), raw.width, raw.height, raw.width * 4, QImage::Format_RGBA8888);
        return qimg.copy();
    }
    return {};
}

RawImage qimage_to_raw(const QImage& qimg) {
    if (qimg.isNull()) return {};
    QImage converted = qimg.convertToFormat(QImage::Format_RGBA8888);
    RawImage raw;
    raw.width = converted.width();
    raw.height = converted.height();
    raw.channels = 4;
    raw.data.assign(converted.bits(), converted.bits() + converted.sizeInBytes());
    return raw;
}
#endif

} // namespace feedback
