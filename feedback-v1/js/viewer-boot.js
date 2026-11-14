(function () {
    // 快速前置鉴权与会话检查，避免未登录或无参数时出现加载遮罩闪烁
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('id');

    // 1. 若没有携带 id 参数，则没有任何学情数据可展示，直接判断登录并立即跳转，不加载后续任何DOM
    if (!sessionId) {
        fetch('api/auth.php?action=check')
            .then(r => r.json())
            .then(res => {
                if (res && res.success && res.data && res.data.loggedIn) {
                    window.location.replace('upload.html');
                } else {
                    window.location.replace('index.html');
                }
            })
            .catch(() => {
                window.location.replace('index.html');
            });
        return;
    }

    // 2. 若携带了 id 参数，同样先验证登录状态，未登录立即跳转登录页
    fetch('api/auth.php?action=check')
        .then(r => r.json())
        .then(res => {
            const loggedIn = res && res.success && res.data && res.data.loggedIn;
            if (!loggedIn) {
                window.location.replace('index.html');
                return;
            }
            // 确认登录且有数据，允许展示遮罩
            const screen = document.getElementById('viewer-loading-screen');
            if (screen) {
                screen.style.display = 'flex';
            }
        })
        .catch(() => {});
})();
