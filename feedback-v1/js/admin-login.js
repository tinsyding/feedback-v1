const API_BASE = 'api/admin.php';

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('login-error');
    const loginBtn = document.getElementById('login-btn');

    loginBtn.disabled = true;
    loginBtn.textContent = '登录中...';
    errorEl.classList.remove('show');

    try {
        const response = await fetch(`${API_BASE}?action=login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const result = await response.json();

        if (result.success) {
            window.location.href = 'admin.html';
        } else {
            errorEl.textContent = result.error || '账号或密码错误';
            errorEl.classList.add('show');
            loginBtn.disabled = false;
            loginBtn.textContent = '登录';
        }
    } catch (err) {
        errorEl.textContent = '网络连接失败';
        errorEl.classList.add('show');
        loginBtn.disabled = false;
        loginBtn.textContent = '登录';
    }
});

// 自动检查登录状态
(async () => {
    try {
        const response = await fetch(`${API_BASE}?action=check`);
        const result = await response.json();
        if (result.success && result.data?.loggedIn) {
            window.location.href = 'admin.html';
        }
    } catch (err) {}
})();
