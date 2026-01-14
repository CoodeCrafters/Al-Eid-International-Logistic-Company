
class Signup {
    constructor() {
        this.currentUser = null;
        this.otpTimer = null;
        this.resendTimer = null;
        this.timeLeft = 300; // 5 minutes in seconds
        this.resendTimeLeft = 60; // 60 seconds for resend
        
        // Only initialize event listeners if we're on a page with these elements
        this.initializeIfNeeded();
    }

    initializeIfNeeded() {
        // Check if we're on a signup page (has signup form)
        const signupForm = document.getElementById('signupForm');
        if (signupForm) {
            this.initEventListeners();
        }
    }

    initEventListeners() {
        // Only attach toggle if element exists (for combined login/signup page)
        const toggleSignup = document.getElementById('toggleSignup');
        if (toggleSignup) {
            toggleSignup.addEventListener('click', () => this.toggleForms());
        }
        
        // Signup form submission
        const signupForm = document.getElementById('signupForm');
        if (signupForm) {
            signupForm.addEventListener('submit', (e) => this.handleSignup(e));
        }
        
        // Username availability check
        const checkUsernameBtn = document.getElementById('checkUsernameBtn');
        if (checkUsernameBtn) {
            checkUsernameBtn.addEventListener('click', () => this.checkUsername());
        }

        sessionStorage.setItem("signupUsername", username);
        sessionStorage.setItem("signupEmail", email);
        
        // OTP verification
        const verifyOtpBtn = document.getElementById('verifyOtpBtn');
        if (verifyOtpBtn) {
            verifyOtpBtn.addEventListener('click', () => this.verifyOtp());
        }
        
        // Resend OTP
        const resendOtpBtn = document.getElementById('resendOtpBtn');
        if (resendOtpBtn) {
            resendOtpBtn.addEventListener('click', () => this.resendOtp());
        }
        
        // Cancel OTP verification
        const cancelOtpBtn = document.getElementById('cancelOtpBtn');
        if (cancelOtpBtn) {
            cancelOtpBtn.addEventListener('click', () => this.cancelOtp());
        }
        
        // OTP input auto-focus
        this.setupOtpInputs();
        
        // Real-time password validation
        const signupPassword = document.getElementById('signupPassword');
        const confirmPassword = document.getElementById('confirmPassword');
        
        if (signupPassword) {
            signupPassword.addEventListener('input', () => this.validatePassword());
        }
        
        if (confirmPassword) {
            confirmPassword.addEventListener('input', () => this.validatePassword());
        }
    }

    toggleForms() {
        // Only works on combined login/signup page
        const loginForm = document.getElementById('loginForm');
        const signupForm = document.getElementById('signupForm');
        const toggleText = document.getElementById('toggleSignup');
        
        if (loginForm && signupForm && toggleText) {
            if (signupForm.style.display === 'none') {
                // Show signup form
                loginForm.style.display = 'none';
                signupForm.style.display = 'block';
                toggleText.textContent = 'Back to Login';
                Utils.hideAlert();
                this.resetSignupForm();
            } else {
                // Show login form
                signupForm.style.display = 'none';
                loginForm.style.display = 'block';
                toggleText.textContent = 'Create New Account';
                Utils.hideAlert();
            }
        }
    }

    resetSignupForm() {
        const signupForm = document.getElementById('signupForm');
        const usernameStatus = document.getElementById('usernameStatus');
        const checkUsernameBtn = document.getElementById('checkUsernameBtn');
        
        if (signupForm) signupForm.reset();
        if (usernameStatus) {
            usernameStatus.textContent = '';
            usernameStatus.className = 'status-message';
        }
        if (checkUsernameBtn) {
            checkUsernameBtn.disabled = false;
            checkUsernameBtn.textContent = 'Check';
            checkUsernameBtn.style.background = '#17a2b8';
        }
        this.currentUser = null;
    }

    validatePassword() {
        const password = document.getElementById('signupPassword');
        const confirmPassword = document.getElementById('confirmPassword');
        const signupBtn = document.getElementById('signupText')?.parentElement;
        
        if (!password || !confirmPassword || !signupBtn) return false;
        
        const passwordValue = password.value;
        const confirmPasswordValue = confirmPassword.value;
        
        if (passwordValue && confirmPasswordValue) {
            if (passwordValue !== confirmPasswordValue) {
                Utils.showAlert('Passwords do not match', 'error');
                signupBtn.disabled = true;
                return false;
            }
            
            if (passwordValue.length < 6) {
                Utils.showAlert('Password must be at least 6 characters', 'error');
                signupBtn.disabled = true;
                return false;
            }
            
            Utils.hideAlert();
            signupBtn.disabled = false;
            return true;
        }
        
        return false;
    }

    async checkUsername() {
        const usernameInput = document.getElementById('signupUsername');
        const statusDiv = document.getElementById('usernameStatus');
        const checkBtn = document.getElementById('checkUsernameBtn');
        
        if (!usernameInput || !statusDiv || !checkBtn) return;
        
        const username = usernameInput.value.trim();
        
        if (!username) {
            statusDiv.textContent = 'Please enter a username';
            statusDiv.className = 'status-message status-error';
            return;
        }
        
        if (username.length < 3) {
            statusDiv.textContent = 'Username must be at least 3 characters';
            statusDiv.className = 'status-message status-error';
            return;
        }
        
        this.setUsernameCheckLoading(true);
        statusDiv.textContent = 'Checking availability...';
        statusDiv.className = 'status-message';
        
        try {
            const response = await Utils.checkUsernameExists(username);
            
            if (response.available) {
                statusDiv.textContent = '✓ Username is available';
                statusDiv.className = 'status-message status-success';
                checkBtn.disabled = true;
                checkBtn.textContent = 'Available';
                checkBtn.style.background = '#28a745';
            } else {
                statusDiv.textContent = '✗ Username is already taken';
                statusDiv.className = 'status-message status-error';
                checkBtn.disabled = false;
            }
        } catch (error) {
            statusDiv.textContent = 'Error checking username. Please try again.';
            statusDiv.className = 'status-message status-error';
            console.error('Username check error:', error);
        } finally {
            this.setUsernameCheckLoading(false);
        }
    }

    async handleSignup(e) {
    e.preventDefault();
    
    // Validate all fields
    const name = document.getElementById('signupName')?.value.trim();
    const email = document.getElementById('signupEmail')?.value.trim();
    const gender = document.getElementById('signupGender')?.value;
    const username = document.getElementById('signupUsername')?.value.trim();
    const password = document.getElementById('signupPassword')?.value;
    const confirmPassword = document.getElementById('confirmPassword')?.value;
    const agreeTerms = document.getElementById('agreeTerms')?.checked;
    
    // Basic validation
    if (!name || !email || !gender || !username || !password || !confirmPassword) {
        Utils.showAlert('Please fill in all fields', 'error');
        return;
    }
    
    if (!agreeTerms) {
        Utils.showAlert('You must agree to the terms and conditions', 'error');
        return;
    }
    
    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        Utils.showAlert('Please enter a valid email address', 'error');
        return;
    }
    
    // Password validation
    if (!this.validatePassword()) {
        return;
    }
    
    // Check if username was verified
    const statusDiv = document.getElementById('usernameStatus');
    if (statusDiv && !statusDiv.textContent.includes('available')) {
        Utils.showAlert('Please check username availability first', 'error');
        return;
    }
    
    this.setSignupLoading(true);
    
    try {
        // Prepare user data
        const userData = {
            name,
            email,
            gender,
            username,
            password,
            role: 'employee' // Default role for new signups
        };
        
        // Save user data temporarily in localStorage to use on OTP page
        localStorage.setItem('pendingRegistration', JSON.stringify(userData));
        
        // 1️⃣ FIRST: REGISTER THE USER (creates user in database)
        const registerResponse = await fetch(`${Utils.getApiBaseUrl()}/api/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(userData)
        });
        
        if (!registerResponse.ok) {
            const errorData = await registerResponse.json().catch(() => ({}));
            throw new Error(errorData.message || `HTTP error! status: ${registerResponse.status}`);
        }
        
        const registerData = await registerResponse.json();
        
        if (!registerData.success) {
            throw new Error(registerData.message || 'Registration failed');
        }
        
                // ✅ ADD THIS - Redirect after successful registration
        const encodedUsername = encodeURIComponent(username);
        const encodedEmail = encodeURIComponent(email);

        Utils.showAlert('Registration successful! Check your email for verification code.', 'success');

        setTimeout(() => {
            window.location.href = `otp-verification.html?username=${encodedUsername}&email=${encodedEmail}`;
        }, 1500);
        
    } catch (error) {
        console.error('Signup error:', error);
        Utils.showAlert('Signup failed: ' + error.message, 'error');
        // Clear localStorage on error
        localStorage.removeItem('pendingRegistration');
    } finally {
        this.setSignupLoading(false);
    }
}

// Remove showOtpModal method or update it to redirect
showOtpModal() {
    // Redirect instead of showing modal
    if (this.currentUser?.username) {
        const encodedUsername = encodeURIComponent(this.currentUser.username);
        const encodedEmail = encodeURIComponent(this.currentUser.email);
        window.location.href = `otp-verification.html?username=${encodedUsername}&email=${encodedEmail}`;
    }
}

// Remove hideOtpModal method since we're redirecting
hideOtpModal() {
    // This method is no longer needed
}

// Remove cancelOtp method or update it
cancelOtp() {
    // Clear localStorage and redirect back to signup
    localStorage.removeItem('pendingRegistration');
    window.location.href = 'signup.html';
}

// Keep other methods as they are - they'll be used on the OTP page

    setupOtpInputs() {
        const otpInputs = document.querySelectorAll('.otp-input');
        
        otpInputs.forEach((input, index) => {
            input.addEventListener('input', (e) => {
                if (input.value.length === 1 && index < otpInputs.length - 1) {
                    otpInputs[index + 1].focus();
                }
            });
            
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !input.value && index > 0) {
                    otpInputs[index - 1].focus();
                }
            });
            
            // Allow only numbers
            input.addEventListener('keypress', (e) => {
                if (!/^\d$/.test(e.key)) {
                    e.preventDefault();
                }
            });
        });
    }

    resetOtpInputs() {
        const otpInputs = document.querySelectorAll('.otp-input');
        otpInputs.forEach(input => {
            input.value = '';
            input.style.borderColor = '#ddd';
        });
        if (otpInputs.length > 0) {
            otpInputs[0].focus();
        }
        
        const otpStatus = document.getElementById('otpStatus');
        if (otpStatus) otpStatus.textContent = '';
    }

    getOtpCode() {
        const otpInputs = document.querySelectorAll('.otp-input');
        return Array.from(otpInputs).map(input => input.value).join('');
    }

    async verifyOtp() {
        const otpCode = this.getOtpCode();
        const statusDiv = document.getElementById('otpStatus');
        
        if (otpCode.length !== 6) {
            if (statusDiv) {
                statusDiv.textContent = 'Please enter the complete 6-digit code';
                statusDiv.className = 'status-message status-error';
            }
            return;
        }
        
        this.setVerifyLoading(true);
        
        try {
            // ✅ JUST VERIFY OTP (user already registered in handleSignup)
            const verifyResponse = await fetch(`${Utils.getApiBaseUrl()}/verify-otp`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    username: this.currentUser?.username,
                    code: otpCode
                })
            });
            
            if (!verifyResponse.ok) {
                const errorData = await verifyResponse.json().catch(() => ({}));
                throw new Error(errorData.message || `HTTP error! status: ${verifyResponse.status}`);
            }
            
            const verifyData = await verifyResponse.json();
            
        if (verifyData.success) {
            // ✅ User already registered, just show success
            this.hideOtpModal();
            this.showSuccessMessage();
            
            // Redirect to login page after success
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 3000);
        } else {
            throw new Error(verifyData.message || 'Invalid verification code');
        }
        
    } catch (error) {
        console.error('Verification error:', error);
        if (statusDiv) {
            statusDiv.textContent = error.message || 'Verification failed. Please try again.';
            statusDiv.className = 'status-message status-error';
        }
    } finally {
        this.setVerifyLoading(false);
    }
}

    async resendOtp() {
        if (this.resendTimeLeft > 0) return;
        
        this.setResendLoading(true);
        
        try {
            const response = await fetch(`${Utils.getApiBaseUrl()}/send-verification`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    username: this.currentUser?.username
                    // Remove email parameter, backend only needs username
                })
            });
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.success) {
                // Reset resend timer
                this.resendTimeLeft = 60;
                this.startResendTimer();
                this.resetOtpInputs();
                
                const otpStatus = document.getElementById('otpStatus');
                if (otpStatus) {
                    otpStatus.textContent = 'New code sent successfully!';
                    otpStatus.className = 'status-message status-success';
                }
            } else {
                throw new Error(data.message || 'Failed to resend code');
            }
            
        } catch (error) {
            console.error('Resend error:', error);
            const otpStatus = document.getElementById('otpStatus');
            if (otpStatus) {
                otpStatus.textContent = 'Failed to resend code. Please try again.';
                otpStatus.className = 'status-message status-error';
            }
        } finally {
            this.setResendLoading(false);
        }
    }

    cancelOtp() {
        this.hideOtpModal();
        this.resetSignupForm();
    }

    startOtpTimer() {
        this.clearTimers();
        
        this.otpTimer = setInterval(() => {
            this.timeLeft--;
            this.updateTimerDisplay();
            
            if (this.timeLeft <= 0) {
                this.clearTimers();
                const otpStatus = document.getElementById('otpStatus');
                const verifyOtpBtn = document.getElementById('verifyOtpBtn');
                
                if (otpStatus) {
                    otpStatus.textContent = 'Verification code has expired';
                    otpStatus.className = 'status-message status-error';
                }
                if (verifyOtpBtn) verifyOtpBtn.disabled = true;
            }
        }, 1000);
    }

    startResendTimer() {
        if (this.resendTimer) clearInterval(this.resendTimer);
        
        const resendBtn = document.getElementById('resendOtpBtn');
        if (!resendBtn) return;
        
        resendBtn.disabled = true;
        
        this.resendTimer = setInterval(() => {
            this.resendTimeLeft--;
            resendBtn.textContent = `Resend Code (${this.resendTimeLeft}s)`;
            
            if (this.resendTimeLeft <= 0) {
                clearInterval(this.resendTimer);
                resendBtn.disabled = false;
                resendBtn.textContent = 'Resend Code';
            }
        }, 1000);
    }

    updateTimerDisplay() {
        const minutes = Math.floor(this.timeLeft / 60);
        const seconds = this.timeLeft % 60;
        const timerElement = document.getElementById('timer');
        
        if (timerElement) {
            timerElement.textContent = 
                `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }

    clearTimers() {
        if (this.otpTimer) {
            clearInterval(this.otpTimer);
            this.otpTimer = null;
        }
        if (this.resendTimer) {
            clearInterval(this.resendTimer);
            this.resendTimer = null;
        }
    }

    showSuccessMessage() {
        const successAlert = document.getElementById('successAlert');
        if (successAlert) {
            successAlert.textContent = 'Account created successfully! You can now login with your credentials.';
            successAlert.className = 'alert alert-success';
            successAlert.style.display = 'block';
            
            setTimeout(() => {
                successAlert.style.display = 'none';
            }, 5000);
        }
    }

    // Loading states
    setUsernameCheckLoading(isLoading) {
        const checkBtn = document.getElementById('checkUsernameBtn');
        if (!checkBtn) return;
        
        if (isLoading) {
            checkBtn.disabled = true;
            checkBtn.textContent = 'Checking...';
            checkBtn.style.background = '#6c757d';
        } else {
            checkBtn.disabled = false;
            checkBtn.textContent = 'Check';
            checkBtn.style.background = '#17a2b8';
        }
    }

    setSignupLoading(isLoading) {
        const signupText = document.getElementById('signupText');
        const signupSpinner = document.getElementById('signupSpinner');
        const signupBtn = document.getElementById('signupText')?.parentElement;
        
        if (!signupText || !signupSpinner || !signupBtn) return;
        
        if (isLoading) {
            signupText.style.display = 'none';
            signupSpinner.style.display = 'block';
            signupBtn.disabled = true;
            signupBtn.textContent = 'CREATING ACCOUNT...';
        } else {
            signupText.style.display = 'block';
            signupSpinner.style.display = 'none';
            signupBtn.disabled = false;
            signupText.textContent = 'CREATE ACCOUNT';
        }
    }

    setVerifyLoading(isLoading) {
        const verifyBtn = document.getElementById('verifyOtpBtn');
        if (!verifyBtn) return;
        
        if (isLoading) {
            verifyBtn.disabled = true;
            verifyBtn.textContent = 'VERIFYING...';
        } else {
            verifyBtn.disabled = false;
            verifyBtn.textContent = 'VERIFY & COMPLETE';
        }
    }

    setResendLoading(isLoading) {
        const resendBtn = document.getElementById('resendOtpBtn');
        if (!resendBtn) return;
        
        if (isLoading) {
            resendBtn.disabled = true;
            resendBtn.textContent = 'SENDING...';
        } else {
            resendBtn.disabled = false;
            resendBtn.textContent = 'Resend Code';
        }
    }
}

// Initialize when DOM is loaded - but only on pages with signup form
document.addEventListener('DOMContentLoaded', function() {
    const signupForm = document.getElementById('signupForm');
    if (signupForm) {
        new Signup();
    }
});



        // Custom initialization for signup page
        document.addEventListener('DOMContentLoaded', function() {
            console.log('Signup page loaded');
            
            // Initialize the Signup class from signup.js
            const signup = new Signup();
            console.log('Signup class initialized');
            
            // Make sure username check button is properly connected
            const checkUsernameBtn = document.getElementById('checkUsernameBtn');
            if (checkUsernameBtn) {
                console.log('Username check button found');
                checkUsernameBtn.addEventListener('click', function() {
                    console.log('Check username button clicked');
                    signup.checkUsername();
                });
            } else {
                console.error('Username check button NOT FOUND!');
            }
            
            // Password strength checker
            function checkPasswordStrength(password) {
                const strengthFill = document.getElementById('strengthFill');
                const strengthText = document.getElementById('strengthText');
                
                if (!password) {
                    strengthFill.className = 'strength-fill';
                    strengthFill.style.width = '0%';
                    strengthText.textContent = 'None';
                    return;
                }
                
                let strength = 0;
                
                // Length check
                if (password.length >= 6) strength++;
                if (password.length >= 10) strength++;
                
                // Complexity checks
                if (/[a-z]/.test(password)) strength++;
                if (/[A-Z]/.test(password)) strength++;
                if (/[0-9]/.test(password)) strength++;
                if (/[^A-Za-z0-9]/.test(password)) strength++;
                
                // Determine strength level
                let strengthClass, strengthLabel;
                if (strength <= 2) {
                    strengthClass = 'strength-weak';
                    strengthLabel = 'Weak';
                } else if (strength <= 4) {
                    strengthClass = 'strength-fair';
                    strengthLabel = 'Fair';
                } else if (strength <= 6) {
                    strengthClass = 'strength-good';
                    strengthLabel = 'Good';
                } else {
                    strengthClass = 'strength-strong';
                    strengthLabel = 'Strong';
                }
                
                strengthFill.className = 'strength-fill ' + strengthClass;
                strengthText.textContent = strengthLabel;
            }
            
            // Real-time password strength checking
            const passwordInput = document.getElementById('signupPassword');
            if (passwordInput) {
                passwordInput.addEventListener('input', function(e) {
                    checkPasswordStrength(e.target.value);
                });
            }
            
            // Real-time password match checking
            const confirmPasswordInput = document.getElementById('confirmPassword');
            if (confirmPasswordInput) {
                confirmPasswordInput.addEventListener('input', function() {
                    const password = document.getElementById('signupPassword').value;
                    const confirmPassword = this.value;
                    const matchStatus = document.getElementById('passwordMatchStatus');
                    
                    if (!confirmPassword) {
                        matchStatus.textContent = '';
                        matchStatus.className = 'status-message';
                        return;
                    }
                    
                    if (password === confirmPassword) {
                        matchStatus.textContent = '✓ Passwords match';
                        matchStatus.className = 'status-message status-success';
                    } else {
                        matchStatus.textContent = '✗ Passwords do not match';
                        matchStatus.className = 'status-message status-error';
                    }
                });
            }
            
         
                
               
                
           
            updateDateTime();
            setInterval(updateDateTime, 1000);
            
            // Handle ESC key to go back
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') {
                    // If OTP modal is open, close it
                    const otpModal = document.getElementById('otpModal');
                    if (otpModal && otpModal.style.display === 'flex') {
                        signup.cancelOtp();
                    } else {
                        // Otherwise go back to login
                        window.location.href = 'login.html';
                    }
                    e.preventDefault();
                }
                
                // F1 for help
                if (e.key === 'F1') {
                    e.preventDefault();
                    alert('Help: Fill in all required fields and ensure your password is at least 6 characters long. After submission, you will receive a verification code from your supervisor.');
                }
                
                // Auto-focus next input on Enter
                if (e.key === 'Enter' && e.target.type !== 'submit' && e.target.tagName !== 'BUTTON') {
                    e.preventDefault();
                    const inputs = document.querySelectorAll('#signupForm input, #signupForm select');
                    const currentIndex = Array.from(inputs).indexOf(e.target);
                    if (currentIndex < inputs.length - 1) {
                        inputs[currentIndex + 1].focus();
                    }
                }
            });
            
            // Auto-focus first input
            const firstInput = document.getElementById('signupName');
            if (firstInput) {
                setTimeout(() => {
                    firstInput.focus();
                }, 100);
            }
            
            // Add input validation for better UX
            const formInputs = document.querySelectorAll('#signupForm input, #signupForm select');
            formInputs.forEach(input => {
                input.addEventListener('blur', function() {
                    if (this.value.trim() === '' && this.hasAttribute('required')) {
                        this.style.borderColor = '#dc3545';
                    } else {
                        this.style.borderColor = '#ddd';
                    }
                });
                
                input.addEventListener('input', function() {
                    this.style.borderColor = '#ddd';
                });
            });
        });
    