use desktop_sender_rs::header_verify::{
    apply_vlm_double_check, compute_header_crop_rect, judge_header_text, HeaderVerdict,
};

/// 100% 缩放、窗口位于 (0,0)、主屏 1920x1080 时的基准裁剪框
const BASE_SCREEN: (i32, i32, i32, i32) = (0, 0, 1920, 1080);

#[test]
fn test_full_match_releases() {
    let c = judge_header_text("90001张三", "90001", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Match);
    assert!(c.allows_send());
}

#[test]
fn test_full_match_tolerates_spaces() {
    // OCR 常在汉字间插入空格，比对前必须抹掉
    let c = judge_header_text("90001 张三 妈妈", "90001", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Match);
}

#[test]
fn test_full_match_tolerates_suffix_and_emoji() {
    // 企微标题常见后缀：@微信 / 表情符号
    let c = judge_header_text("90001张三妈妈@微信 💐", "90001", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Match);
}

#[test]
fn test_other_student_id_is_mismatch() {
    // 判据 A：标题是其他学生的学号
    let c = judge_header_text("90002李四", "90001", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Mismatch);
    assert!(c.reason.contains("其他学生学号"));
    assert!(!c.allows_send());
}

#[test]
fn test_other_contact_at_sign_is_mismatch() {
    // 判据 B：含 @ 微信 但不含目标姓名
    let c = judge_header_text("王五妈妈@微信", "90001", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Mismatch);
    assert!(!c.allows_send());
}

#[test]
fn test_name_only_without_id_is_mismatch() {
    // 只有姓名没有学号 —— 极可能是下拉选错了人，必须拦
    let c = judge_header_text("李四妈妈", "90001", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Mismatch);
    assert!(!c.allows_send());
}

#[test]
fn test_empty_text_is_uncertain_fail_closed() {
    // OCR 什么都没读到 —— fail-closed 拦截，绝不放行
    let c = judge_header_text("", "90001", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Uncertain);
    assert!(!c.allows_send(), "读不到标题时绝不能放行");
}

#[test]
fn test_whitespace_only_text_is_uncertain_fail_closed() {
    let c = judge_header_text("   \t ", "90001", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Uncertain);
    assert!(!c.allows_send());
}

#[test]
fn test_id_only_target_still_matches() {
    // 只提供学号（无姓名）时，按学号判定即可
    let c = judge_header_text("90001张三", "90001", "");
    assert_eq!(c.verdict, HeaderVerdict::Match);
}

#[test]
fn test_name_only_target_still_matches() {
    // 只提供姓名时，按姓名判定即可
    let c = judge_header_text("张三妈妈", "", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Match);
}

#[test]
fn test_no_target_cannot_match() {
    // 学号与姓名都为空时无法核验 —— 必须 fail-closed
    let c = judge_header_text("90001张三", "", "");
    assert_eq!(c.verdict, HeaderVerdict::Mismatch);
    assert!(!c.allows_send());
}

#[test]
fn test_long_digit_run_does_not_falsely_match() {
    // 标题里是 11 位手机号，不是目标学号 —— 必须拦截
    let c = judge_header_text("13800138000", "90001", "张三");
    assert!(!c.allows_send());
}

#[test]
fn test_partial_id_prefix_is_not_a_match() {
    // 90001 是 900012 的前缀，不能算命中
    let c = judge_header_text("900012李四", "90001", "张三");
    // 900012 不含 "90001" 作为完整学号，但 scan_id_runs 会取到 900012 ≠ 90001
    assert_eq!(c.verdict, HeaderVerdict::Mismatch);
}

// ========== 云端大模型二次防御 ==========

#[test]
fn test_vlm_double_check_accepts_consistent_match() {
    let c = apply_vlm_double_check(true, "90001张三", "90001", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Match);
    assert!(c.allows_send());
}

#[test]
fn test_vlm_double_check_downgrades_false_positive() {
    // 模型误报 matched=true，但标题里根本没有目标学号/姓名 —— 必须纠偏为拦截
    let c = apply_vlm_double_check(true, "王五妈妈@微信", "90001", "张三");
    assert_eq!(
        c.verdict,
        HeaderVerdict::Mismatch,
        "大模型幻觉不得直接放行误发"
    );
    assert!(!c.allows_send());
}

#[test]
fn test_vlm_double_check_accepts_negative() {
    let c = apply_vlm_double_check(false, "王五妈妈", "90001", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Mismatch);
    assert!(!c.allows_send());
}

#[test]
fn test_vlm_double_check_empty_title_is_uncertain() {
    // 模型说匹配但没给出标题 —— 无法复核，fail-closed
    let c = apply_vlm_double_check(true, "", "90001", "张三");
    assert_eq!(c.verdict, HeaderVerdict::Mismatch);
    assert!(!c.allows_send());
}

// ========== 裁剪区域计算 ==========

#[test]
fn test_crop_rect_at_100_percent() {
    let (x, y, w, h) = compute_header_crop_rect((0, 0, 1200), 1.0, BASE_SCREEN);
    // offset_x = 240, offset_y = 4
    assert_eq!(x, 240);
    assert_eq!(y, 4);
    // min(400, max(200, 1200 - 260)) = min(400, 940) = 400
    assert_eq!(w, 400);
    // max(40, 52) = 52
    assert_eq!(h, 52);
}

#[test]
fn test_crop_rect_scales_with_dpi() {
    let (x, y, w, h) = compute_header_crop_rect((0, 0, 1200), 2.0, BASE_SCREEN);
    // 200% 缩放：偏移与尺寸全部翻倍
    assert_eq!(x, 480);
    assert_eq!(y, 8);
    // min(800, max(200, 1200 - 520)) = min(800, 680) = 680，且 >= 320
    assert_eq!(w, 680);
    assert_eq!(h, 104);
}

#[test]
fn test_crop_rect_narrow_window_uses_floor() {
    // 窗口很窄时宽度落到下限，不会算出 0 或负数
    // max(160, min(400, max(200, 300 - 260))) = max(160, min(400, 200)) = 200
    let (x, _y, w, _h) = compute_header_crop_rect((0, 0, 300), 1.0, BASE_SCREEN);
    assert_eq!(x, 240);
    assert_eq!(w, 200, "窄窗口下宽度退到 200px 下限");
    assert!(w > 0);
}

#[test]
fn test_crop_rect_clamped_to_virtual_screen_right_edge() {
    // 副屏在右侧：虚拟桌面右边界 3200，裁剪框不得越界
    let screen = (0, 0, 3200, 1080);
    let (x, _y, w, _h) = compute_header_crop_rect((2000, 0, 1200), 1.0, screen);
    assert!(x + w <= 3200, "裁剪框必须收敛到虚拟桌面右边界内");
}

#[test]
fn test_crop_rect_clamped_with_negative_virtual_origin() {
    // 副屏在左侧：vx 为负，裁剪起点不得小于 vx
    let screen = (-1920, 0, 1920, 1080);
    let (x, _y, w, h) = compute_header_crop_rect((-1900, 0, 1200), 1.0, screen);
    assert!(x >= -1920, "裁剪起点不得越过虚拟桌面左边界");
    assert!(x + w <= 0);
    assert!(h > 0);
}

#[test]
fn test_crop_rect_respects_screen_height_floor() {
    // 极矮的虚拟桌面：高度收敛但保底 30px，不会出现 0/负高度
    let screen = (0, 0, 1920, 40);
    let (_x, y, _w, h) = compute_header_crop_rect((0, 0, 1200), 1.0, screen);
    assert!(h >= 30, "高度必须保底，避免空区域截图");
    assert!(y + h <= 40);
}