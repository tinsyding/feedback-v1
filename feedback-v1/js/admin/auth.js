/**
 * Admin 身份认证模块 (checkAuth, logout, changePassword)
 */

        /* ========================================================
           Authentication & Authorization
           ======================================================== */
        async function redirectNonAdminTarget() {
            try {
                const authRes = await fetch('api/auth.php?action=check');
                const authJson = await authRes.json();
                if (authJson.success && authJson.data?.loggedIn) {
                    window.location.replace('upload.html');
                    return;
                }
            } catch (_) {}
            window.location.replace('index.html');
        }

        async function checkAuth() {
            try {
                const response = await fetch(`${API_BASE}?action=check`);
                const result = await response.json();
                if (!result.success || !result.data?.loggedIn) {
                    await redirectNonAdminTarget();
                    return false;
                }
                const uname = result.data.username || '管理员';
                document.getElementById('admin-username').textContent = uname;
                document.getElementById('user-avatar-letter').textContent = (uname[0] || 'A').toUpperCase();
                return true;
            } catch (err) {
                await redirectNonAdminTarget();
                return false;
            }
        }

        async function logout() {
            const confirmed = await showConfirm('安全退出', '您确定要退出当前管理员账号并返回登录界面吗？', false);
            if (!confirmed) return;
            try {
                await fetch(`${API_BASE}?action=logout`, { method: 'POST' });
            } catch (err) {}
            window.location.href = 'index.html';
        }

        function openChangePwdModal() {
            const modal = document.getElementById('change-pwd-modal');
            if (!modal) return;
            const pOld = document.getElementById('pwd-old');
            const pNew = document.getElementById('pwd-new');
            const pConf = document.getElementById('pwd-confirm');
            if (pOld) pOld.value = '';
            if (pNew) pNew.value = '';
            if (pConf) pConf.value = '';
            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true });
            } else {
                modal.style.display = 'flex';
            }
        }

        function closeChangePwdModal() {
            const modal = document.getElementById('change-pwd-modal');
            if (modal) {
                if (window.DialogHelper) {
                    window.DialogHelper.close(modal);
                } else {
                    modal.style.display = 'none';
                }
            }
        }

        async function submitChangePwd() {
            const oldPassword = document.getElementById('pwd-old')?.value;
            const newPassword = document.getElementById('pwd-new')?.value;
            const confirmPassword = document.getElementById('pwd-confirm')?.value;
            const saveBtn = document.getElementById('btn-save-pwd');

            if (!oldPassword) {
                showToast('请输入当前原密码', 'warn');
                return;
            }
            if (!newPassword || newPassword.length < 6) {
                showToast('新密码长度不能少于 6 位', 'warn');
                return;
            }
            if (newPassword !== confirmPassword) {
                showToast('两次输入的新密码不一致', 'warn');
                return;
            }

            try {
                if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '正在保存...'; }
                const res = await fetch(`${API_BASE}?action=change_password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        old_password: oldPassword,
                        new_password: newPassword
                    })
                });
                const json = await res.json();
                if (json.success) {
                    closeChangePwdModal();
                    showToast('密码修改成功，请妥善保管', 'success');
                } else {
                    showToast(json.error || '修改密码失败', 'error');
                }
            } catch (e) {
                showToast('网络请求失败', 'error');
            } finally {
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存新密码'; }
            }
        }

