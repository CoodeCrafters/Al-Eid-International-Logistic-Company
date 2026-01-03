
class Auth {
    constructor() {
        this.loginAttempts = 0;
        this.maxAttempts = 3;
        this.initEventListeners();
    }

    initEventListeners() {
        const loginForm = document.getElementById('loginForm');
        if (loginForm) {
            loginForm.addEventListener('submit', (e) => this.handleLogin(e));
        }

        // Add input event listeners for real-time validation
        const usernameInput = document.getElementById('username');
        const passwordInput = document.getElementById('password');

        if (usernameInput) {
            usernameInput.addEventListener('input', () => this.validateInputs());
        }

        if (passwordInput) {
            passwordInput.addEventListener('input', () => this.validateInputs());
        }
    }

    validateInputs() {
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const loginBtn = document.querySelector('.login-btn');

        // Basic validation - enable button only if both fields have values
        if (username.trim() && password.trim()) {
            loginBtn.disabled = false;
        } else {
            loginBtn.disabled = true;
        }
    }

   async handleLogin(e) {
    e.preventDefault();
    
    if (this.loginAttempts >= this.maxAttempts) {
        Utils.showAlert('Too many failed attempts. Please contact administrator.');
        return;
    }
    
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    
    // Basic client-side validation
    if (!username || !password) {
        Utils.showAlert('Please enter both username and password');
        return;
    }

    this.setLoading(true);
    Utils.hideAlert();

    try {
        const response = await fetch(`${Utils.getApiBaseUrl()}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                username: username,
                password: password 
            })
        });

        // Check if response is OK before parsing JSON
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        // Check for token OR success message
        if (data.token || data.message === "Login successful") {
            // Remove playBeepSound call or add the function to Utils
            // Utils.playBeepSound(); // Commented out since function doesn't exist
            
            // Store authentication data
            Utils.setToken(data.token);
            sessionStorage.setItem('pos_user', JSON.stringify(data.user));
            
            // Reset login attempts on success
            this.loginAttempts = 0;
            
            // Show success message before redirect
            Utils.showAlert('Login successful! Redirecting...', 'success');
            
            // REDIRECT TO DASHBOARD (not verification.html)
            setTimeout(() => {
                window.location.href = 'Home.html';
            }, 1500);
            
        } else {
            this.loginAttempts++;
            const remainingAttempts = this.maxAttempts - this.loginAttempts;
            
            if (remainingAttempts > 0) {
                Utils.showAlert(`${data.error || data.message} (${remainingAttempts} attempts remaining)`);
            } else {
                Utils.showAlert('Account locked. Please contact system administrator.');
                this.lockLoginForm();
            }
        }
    } catch (error) {
        console.error('Login error:', error);
        this.loginAttempts++;
        
        // Better error messages based on error type
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            Utils.showAlert('Cannot connect to server. Please check if the server is running.');
        } else if (error.message.includes('HTTP error')) {
            Utils.showAlert('Server error. Please try again later.');
        } else {
            Utils.showAlert('Login failed. Please check your credentials and try again.');
        }
    } finally {
        this.setLoading(false);
    }
}

    lockLoginForm() {
        const loginBtn = document.querySelector('.login-btn');
        const usernameInput = document.getElementById('username');
        const passwordInput = document.getElementById('password');
        
        loginBtn.disabled = true;
        usernameInput.disabled = true;
        passwordInput.disabled = true;
        
        loginBtn.textContent = 'ACCOUNT LOCKED';
        loginBtn.style.background = '#dc3545';
    }

    setLoading(isLoading) {
        const loginText = document.getElementById('loginText');
        const loginSpinner = document.getElementById('loginSpinner');
        const loginBtn = document.querySelector('.login-btn');

        if (isLoading) {
            loginText.style.display = 'none';
            loginSpinner.style.display = 'block';
            loginBtn.disabled = true;
            loginBtn.textContent = 'AUTHENTICATING...';
        } else {
            loginText.style.display = 'block';
            loginSpinner.style.display = 'none';
            loginBtn.disabled = false;
            loginText.textContent = 'SIGN IN';
        }
    }

    // Method to handle logout
    static logout() {
        Utils.removeToken();
        window.location.href = '/';
    }
}

// Initialize auth when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    new Auth();
});

// Global logout function
window.logout = Auth.logout;

// Handle browser back button
window.addEventListener('popstate', function() {
    if (Utils.isAuthenticated() && window.location.pathname === '/') {
        window.location.href = '/dashboard';
    }
});
