const AUTH_API = 'api/auth.php';
let isCaptchaRequired = false;

// 页面初始化：校验是否已登录，已登录直接跳反馈页
(async function initLoginState() {
    try {
        const res = await fetch(`${AUTH_API}?action=check`);
        const json = await res.json();
        if (json.success && json.data) {
            if (json.data.loggedIn) {
                window.location.replace('upload.html');
                return;
            }
            if (json.data.require_captcha) {
                showCaptchaField();
            }
        }
    } catch (e) {
        // 忽略网络初始校验异常
    }
})();

// 切换密码明暗文显示
function togglePasswordVisibility() {
    const pwdInput = document.getElementById('password');
    const eyeIcon = document.getElementById('pwd-eye-icon');
    if (!pwdInput) return;
    const isText = pwdInput.type === 'text';
    pwdInput.type = isText ? 'password' : 'text';
    if (eyeIcon) {
        eyeIcon.innerHTML = isText
            ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>'
            : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
    }
}

// 动态展示验证码行并刷新验证码图片
function showCaptchaField() {
    isCaptchaRequired = true;
    const group = document.getElementById('captcha-group');
    if (group) {
        group.style.display = 'block';
    }
    refreshCaptcha();
}

// 刷新图形验证码
function refreshCaptcha() {
    const img = document.getElementById('captcha-img');
    const input = document.getElementById('captcha');
    if (img) {
        img.src = `${AUTH_API}?action=captcha&t=${Date.now()}`;
    }
    if (input) {
        input.value = '';
    }
}

// 显示错误提示并伴随卡片微震反馈
function showError(msg) {
    const alertEl = document.getElementById('error-alert');
    const textEl = document.getElementById('error-text');
    const card = document.getElementById('login-card');
    if (textEl) textEl.textContent = msg || '登录失败，请重试';
    if (alertEl) alertEl.classList.add('show');
    if (card) {
        card.classList.remove('shake');
        void card.offsetWidth;
        card.classList.add('shake');
    }
}

function hideError() {
    const alertEl = document.getElementById('error-alert');
    if (alertEl) alertEl.classList.remove('show');
}

// 表单提交处理
async function handleLoginSubmit(e) {
    e.preventDefault();
    hideError();

    const username = document.getElementById('username')?.value.trim() || '';
    const password = document.getElementById('password')?.value.trim() || '';
    const captchaInput = document.getElementById('captcha');
    const captcha = captchaInput ? captchaInput.value.trim() : '';
    const submitBtn = document.getElementById('submit-btn');

    if (!username) {
        showError('请输入账号');
        document.getElementById('username')?.focus();
        return;
    }

    if (!password) {
        showError('请输入密码');
        document.getElementById('password')?.focus();
        return;
    }

    if (isCaptchaRequired && !captcha) {
        showError('请输入图形验证码');
        captchaInput?.focus();
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="btn-spinner"></span><span>登录中...</span>';
    }

    try {
        const payload = { username, password };
        if (isCaptchaRequired) {
            payload.captcha = captcha;
        }

        const res = await fetch(`${AUTH_API}?action=login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const json = await res.json();

        if (json.success) {
            if (submitBtn) {
                submitBtn.innerHTML = '<span>登录成功</span>';
            }
            window.location.replace('upload.html');
        } else {
            if (json.data && json.data.require_captcha) {
                showCaptchaField();
            } else if (isCaptchaRequired) {
                refreshCaptcha();
            }
            showError(json.error || '账号或密码错误');

            if (isCaptchaRequired && captchaInput) {
                captchaInput.focus();
            } else {
                document.getElementById('password')?.select();
            }

            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<span>登 录</span>';
            }
        }
    } catch (err) {
        showError('网络请求异常，请检查连接');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>登 录</span>';
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('login-form');
    if (form) form.addEventListener('submit', handleLoginSubmit);

    const pwdBtn = document.querySelector('.pwd-toggle-btn');
    if (pwdBtn) pwdBtn.addEventListener('click', togglePasswordVisibility);

    const captchaBox = document.querySelector('.captcha-img-box');
    if (captchaBox) captchaBox.addEventListener('click', refreshCaptcha);
});
