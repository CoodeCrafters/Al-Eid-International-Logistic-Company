// login.js - Complementary to auth.js (only handles Create New Account button)
class LoginManager {
    constructor() {
        this.initEventListeners();
        this.initializeLoginForm();
    }

    initEventListeners() {
        // ✅ ONLY handle Create New Account button - NOT login
        const createAccountBtn = document.getElementById('toggleSignup');
        if (createAccountBtn) {
            console.log('✅ Found Create New Account button, attaching handler...');
            createAccountBtn.addEventListener('click', (e) => {
                e.preventDefault();
                console.log('🔄 Redirecting to signup page...');
                window.location.href = 'signup.html';
            });
        }

        // ✅ Also handle the signup button in the hidden form (if exists)
        const signupBtn = document.getElementById('signupBtn');
        if (signupBtn) {
            signupBtn.addEventListener('click', (e) => {
                e.preventDefault();
                console.log('🔄 Redirecting to signup page from form button...');
                window.location.href = 'signup.html';
            });
        }

        // ✅ Add Enter key support for login form
        const usernameInput = document.getElementById('username');
        const passwordInput = document.getElementById('password');
        const loginBtn = document.querySelector('.login-btn');

        if (usernameInput && loginBtn) {
            usernameInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !loginBtn.disabled) {
                    console.log('⏎ Enter pressed on username field');
                    // Let auth.js handle the login
                    // Just trigger the form submission
                    document.getElementById('loginForm')?.requestSubmit();
                }
            });
        }

        if (passwordInput && loginBtn) {
            passwordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !loginBtn.disabled) {
                    console.log('⏎ Enter pressed on password field');
                    // Let auth.js handle the login
                    document.getElementById('loginForm')?.requestSubmit();
                }
            });
        }

        // ✅ Show/hide password toggle
        const togglePassword = document.getElementById('togglePassword');
        if (togglePassword) {
            togglePassword.addEventListener('click', () => this.togglePasswordVisibility());
        }

        // ✅ Forgot password link
        const forgotPasswordLink = document.getElementById('forgotPassword');
        if (forgotPasswordLink) {
            forgotPasswordLink.addEventListener('click', (e) => {
                e.preventDefault();
                this.handleForgotPassword();
            });
        }
    }

    initializeLoginForm() {
        // Focus on username field on page load
        const usernameInput = document.getElementById('username');
        if (usernameInput) {
            setTimeout(() => usernameInput.focus(), 100);
        }

        // Check if user was redirected due to session timeout
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('timeout')) {
            console.log('⏰ Session timeout detected, showing notification');
            this.showNotification('Session expired. Please login again.', 'warning');
            window.history.replaceState({}, document.title, window.location.pathname);
        }

        if (urlParams.has('logout')) {
            console.log('👋 Logout detected, showing notification');
            this.showNotification('Logged out successfully.', 'success');
            window.history.replaceState({}, document.title, window.location.pathname);
        }

        // Add demo credentials hint
        this.addDemoHint();
    }

    togglePasswordVisibility() {
        const passwordInput = document.getElementById('password');
        const toggleIcon = document.getElementById('togglePassword');
        
        if (passwordInput && toggleIcon) {
            const isPassword = passwordInput.type === 'password';
            passwordInput.type = isPassword ? 'text' : 'password';
            toggleIcon.innerHTML = isPassword ? 
                '<i class="fas fa-eye-slash"></i>' : 
                '<i class="fas fa-eye"></i>';
            console.log('👁️ Password visibility toggled');
        }
    }

    handleForgotPassword() {
        const username = document.getElementById('username')?.value || '';
        
        if (!username) {
            this.showNotification('Please enter your username to reset password', 'warning');
            document.getElementById('username')?.focus();
            return;
        }

        // In a real application, this would call an API endpoint
        this.showNotification(`Password reset instructions sent to ${username}`, 'info');
    }

    showNotification(message, type = 'info') {
        // Use Utils.showNotification if available, otherwise use our own
        if (typeof Utils !== 'undefined' && Utils.showNotification) {
            Utils.showNotification(message, type);
        } else {
            // Fallback simple notification
            console.log(`[${type.toUpperCase()}]: ${message}`);
            alert(`${type.toUpperCase()}: ${message}`);
        }
    }

    addDemoHint() {
        // Remove this in production!
        const demoHint = document.createElement('div');
        demoHint.className = 'demo-hint';
        demoHint.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #f8f9fa;
            border: 1px solid #dee2e6;
            border-radius: 8px;
            padding: 10px 15px;
            font-size: 12px;
            color: #6c757d;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            z-index: 1000;
            max-width: 250px;
        `;
        
        demoHint.innerHTML = `
            <strong>Demo Credentials:</strong><br>
            Username: admin<br>
            Password: admin123
        `;
        
        document.body.appendChild(demoHint);
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('🔧 Initializing LoginManager (complementary to auth.js)...');
    
    // Only initialize on login page
    if (document.getElementById('loginForm')) {
        new LoginManager();
        console.log('✅ LoginManager initialized - Handling only Create New Account button');
    }
});