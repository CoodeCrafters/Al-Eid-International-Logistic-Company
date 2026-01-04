// utils.js - Enhanced version with job card integration
class Utils {
    static async initialize() {
    console.log('🔧 Initializing utilities...');
    
    // Initialize date and time
    this.updateDateTime();
    setInterval(this.updateDateTime, 1000);
    
    // Initialize keyboard shortcuts
    this.initializeKeyboardShortcuts();
    
    // Initialize tooltips
    this.initializeTooltips();
    
    //  CORRECT: Initialize periodic database health checks (every 10 seconds)
    this.initializeDatabaseHealthCheck();
    
    console.log('✔️ Utilities initialized');
}

   // ==================== AUTH/ALERT FUNCTIONS ====================

static getApiBaseUrl() {
    // Always use localhost:5000 for development
    return 'https://mild-cooper-hollywood-miscellaneous.trycloudflare.com/api';
}

static showAlert(message, type = 'info') {
    // Use showNotification if available, otherwise fallback
    if (this.showNotification) {
        this.showNotification(message, type);
    } else {
        // Simple fallback alert
        alert(`${type.toUpperCase()}: ${message}`);
    }
}

static hideAlert() {
    // Hide utils notification
    const existing = document.querySelector('.utils-notification');
    if (existing) existing.remove();
    
    // Also hide any other alerts
    const globalAlert = document.getElementById('global-alert');
    if (globalAlert) globalAlert.remove();
}

static setToken(token) {
    localStorage.setItem('auth_token', token);
}

static removeToken() {
    localStorage.removeItem('auth_token');
}

static isAuthenticated() {
    return !!localStorage.getItem('auth_token');
}

static checkUsernameExists(username) {
    return this.fetchJobCardData('/api/check-username', { username: username });
}
    
    static updateDateTime() {
        try {
            const now = new Date();
            
            // Update all date elements
            document.querySelectorAll('#currentDate, .date-display').forEach(el => {
                if (el && el.id === 'currentDate' || el.classList.contains('date-display')) {
                    el.textContent = now.toLocaleDateString('en-US', {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                    });
                }
            });
            
            // Update all time elements
            document.querySelectorAll('#currentTime, .time-display, #systemTime').forEach(el => {
                if (el) {
                    el.textContent = now.toLocaleTimeString('en-US', {
                        hour12: false,
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                    });
                }
            });
            
            // Update system date
            const systemDate = document.getElementById('systemDate');
            if (systemDate) {
                systemDate.textContent = now.toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                });
            }
        } catch (error) {
            console.log('Date/Time update error:', error);
        }
    }
    
    static initializeDatabaseHealthCheck() {
    // Store the interval ID so we can clear it if needed
    this.healthCheckInterval = null;
    
    // Initial check with retry
    this.performHealthCheckWithRetry();
    
    // Set up periodic checks every 10 seconds
    this.healthCheckInterval = setInterval(() => {
        this.checkDatabaseConnection();
    }, 2000);
    
    console.log('✅ Database health check initialized (every 10 seconds)');
}

static async performHealthCheckWithRetry() {
    const maxRetries = 3;
    const retryDelay = 2000; // 2 seconds
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const isConnected = await this.checkDatabaseConnection();
        
        if (isConnected) {
            console.log(`✅ Database connection successful on attempt ${attempt}`);
            return true;
        }
        
        if (attempt < maxRetries) {
            console.log(`⏳ Retry ${attempt}/${maxRetries} in ${retryDelay/1000} seconds...`);
            await this.delay(retryDelay);
        }
    }
    
    console.log('❌ All database connection attempts failed');
    return false;
}

static delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

static async checkDatabaseConnection() {
    try {
        // Create a unique timestamp to prevent caching
        const timestamp = new Date().getTime();
        const url = `https://mild-cooper-hollywood-miscellaneous.trycloudflare.com/api/health?t=${timestamp}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            },
            // Shorter timeout for periodic checks
            signal: AbortSignal.timeout(3000)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        await response.json(); // We don't need the data, just need to know it's valid JSON
        
        this.updateDatabaseStatus(true);
        return true;
        
    } catch (error) {
        console.log('Database check failed:', error.message);
        this.updateDatabaseStatus(false, error.message);
        return false;
    }
}

static updateDatabaseStatus(isOnline, errorMessage = '') {
    const now = new Date();
    const timeString = now.toLocaleTimeString();
    
    // Update by ID
    const statusElement = document.getElementById('databaseStatus');
    if (statusElement) {
        if (isOnline) {
            statusElement.textContent = '● Database: Online';
            statusElement.className = 'status-online';
            statusElement.title = `Connected (Last check: ${timeString})`;
        } else {
            statusElement.textContent = '● Database: Offline';
            statusElement.className = 'status-offline';
            statusElement.title = `${errorMessage || 'Connection failed'} (Last check: ${timeString})`;
        }
    }
    
    // Also update by class for any other elements
    document.querySelectorAll('.database-status, .db-status').forEach(el => {
        if (isOnline) {
            el.textContent = '● Online';
            el.className = el.className.replace('status-offline', 'status-online');
            if (!el.className.includes('status-online')) {
                el.className += ' status-online';
            }
        } else {
            el.textContent = '● Offline';
            el.className = el.className.replace('status-online', 'status-offline');
            if (!el.className.includes('status-offline')) {
                el.className += ' status-offline';
            }
        }
    });
}
    
    static initializeKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl + S to save
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                const saveBtn = document.querySelector('button[onclick*="saveJobCard"], button[type="submit"]');
                if (saveBtn) {
                    saveBtn.click();
                }
            }
            
            // Ctrl + N for new
            if (e.ctrlKey && e.key === 'n') {
                e.preventDefault();
                const newBtn = document.querySelector('button[onclick*="resetForm"]');
                if (newBtn) {
                    newBtn.click();
                }
            }
            
            // F1 for help
            if (e.key === 'F1') {
                e.preventDefault();
                this.showHelp();
            }
            
            // Escape to cancel/back
            if (e.key === 'Escape') {
                const cancelBtn = document.querySelector('button[onclick*="history.back"]');
                if (cancelBtn) {
                    cancelBtn.click();
                }
            }
        });
    }
    
    static showHelp() {
        const helpText = `
            Keyboard Shortcuts:
            • Ctrl + S: Save current form
            • Ctrl + N: New form/reset
            • F1: Show this help
            • Esc: Go back/cancel
            
            Form Tips:
            • Customer names auto-suggest from database
            • Port suggestions include major Gulf/Asian ports
            • Job numbers auto-generate with EOE/YYYY/ format
            • Auto-filled fields have edit buttons
            • Real-time preview updates as you type
        `;
        
        alert(helpText);
    }
    
    static initializeTooltips() {
        // Add tooltips to elements with data-tooltip attribute
        document.addEventListener('mouseover', (e) => {
            const element = e.target;
            if (element.hasAttribute('data-tooltip')) {
                this.showTooltip(element, element.getAttribute('data-tooltip'));
            }
        });
        
        document.addEventListener('mouseout', (e) => {
            if (e.target.hasAttribute('data-tooltip')) {
                this.hideTooltip();
            }
        });
    }
    
    static showTooltip(element, text) {
        this.hideTooltip();
        
        const tooltip = document.createElement('div');
        tooltip.className = 'custom-tooltip';
        tooltip.textContent = text;
        
        Object.assign(tooltip.style, {
            position: 'absolute',
            background: '#333',
            color: 'white',
            padding: '5px 10px',
            borderRadius: '4px',
            fontSize: '12px',
            zIndex: '10000',
            maxWidth: '200px',
            wordWrap: 'break-word',
            pointerEvents: 'none'
        });
        
        document.body.appendChild(tooltip);
        
        const rect = element.getBoundingClientRect();
        tooltip.style.left = `${rect.left + window.scrollX}px`;
        tooltip.style.top = `${rect.top + window.scrollY - tooltip.offsetHeight - 5}px`;
        
        element._tooltip = tooltip;
    }
    
    static hideTooltip() {
        const existing = document.querySelector('.custom-tooltip');
        if (existing) {
            existing.remove();
        }
    }
    
    // ==================== JOB CARD SPECIFIC UTILITIES ====================
    
    static async fetchWithTimeout(url, options = {}, timeout = 10000) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(id);
            return response;
        } catch (error) {
            clearTimeout(id);
            throw error;
        }
    }
    
    static async fetchJobCardData(endpoint, data = null) {
        const url = `https://mild-cooper-hollywood-miscellaneous.trycloudflare.com${endpoint}`;
        
        try {
            const options = {
                headers: {
                    'Content-Type': 'application/json'
                }
            };
            
            if (data) {
                options.method = 'POST';
                options.body = JSON.stringify(data);
            }
            
            const response = await this.fetchWithTimeout(url, options);
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }
            
            return await response.json();
        } catch (error) {
            console.error(`Error fetching ${endpoint}:`, error);
            throw error;
        }
    }
    
    static async searchCustomers(query) {
        if (!query || query.length < 2) return [];
        
        try {
            const data = await this.fetchJobCardData(`/api/customers/search?q=${encodeURIComponent(query)}`);
            return Array.isArray(data) ? data : (data.customers || []);
        } catch (error) {
            console.error('Customer search failed:', error);
            return [];
        }
    }
    
    static async searchRequesters(query) {
        if (!query || query.length < 2) return [];
        
        try {
            const data = await this.fetchJobCardData(`/api/requesters/search?q=${encodeURIComponent(query)}`);
            return Array.isArray(data) ? data : (data.requesters || []);
        } catch (error) {
            console.error('Requester search failed:', error);
            return [];
        }
    }
    
    static async searchShippers(query) {
        if (!query || query.length < 2) return [];
        
        try {
            const data = await this.fetchJobCardData(`/api/shippers/search?q=${encodeURIComponent(query)}`);
            return Array.isArray(data) ? data : (data.shippers || []);
        } catch (error) {
            console.error('Shipper search failed:', error);
            return [];
        }
    }
    
    static async getNextJobNumber() {
        try {
            const data = await this.fetchJobCardData('/api/jobcards/next-number');
            return data.nextNumber || '00001';
        } catch (error) {
            console.error('Failed to get next job number:', error);
            return '00001';
        }
    }
    
    static async getJobCardStats() {
        try {
            const data = await this.fetchJobCardData('/api/stats/jobcards');
            return data;
        } catch (error) {
            console.error('Failed to get job card stats:', error);
            return {
                totalJobCards: 0,
                submittedJobCards: 0,
                draftJobCards: 0,
                totalInvoices: 0
            };
        }
    }
    
    static async saveJobCardDraft(formData) {
        try {
            const data = await this.fetchJobCardData('/api/jobcards/save-draft', formData);
            return data;
        } catch (error) {
            console.error('Failed to save job card draft:', error);
            throw error;
        }
    }
    
    static async submitJobCard(formData) {
        try {
            const data = await this.fetchJobCardData('/api/jobcards/submit', formData);
            return data;
        } catch (error) {
            console.error('Failed to submit job card:', error);
            throw error;
        }
    }
    
    static async generateInvoiceFromJobCard(jobCardData) {
        try {
            const data = await this.fetchJobCardData('/api/jobcards/generate-invoice', jobCardData);
            return data;
        } catch (error) {
            console.error('Failed to generate invoice:', error);
            throw error;
        }
    }
    
    // ==================== FORM VALIDATION ====================
    
    static validateForm(formElement) {
        const inputs = formElement.querySelectorAll('input[required], select[required], textarea[required]');
        let isValid = true;
        const errors = [];
        
        inputs.forEach(input => {
            if (!input.value.trim()) {
                isValid = false;
                this.markInvalid(input, 'This field is required');
                errors.push(`${input.name || input.id} is required`);
            } else {
                this.markValid(input);
                
                // Additional validations
                if (input.type === 'email' && input.value) {
                    if (!this.isValidEmail(input.value)) {
                        isValid = false;
                        this.markInvalid(input, 'Invalid email format');
                        errors.push('Invalid email format');
                    }
                }
                
                if (input.type === 'tel' && input.value) {
                    if (!this.isValidPhone(input.value)) {
                        isValid = false;
                        this.markInvalid(input, 'Invalid phone number');
                        errors.push('Invalid phone number');
                    }
                }
            }
        });
        
        return { isValid, errors };
    }
    
    static isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }
    
    static isValidPhone(phone) {
        // Basic phone validation - accepts + and numbers
        const phoneRegex = /^[\+\d\s\-\(\)]{10,}$/;
        return phoneRegex.test(phone);
    }
    
    static markInvalid(element, message) {
        element.style.borderColor = '#dc3545';
        element.style.backgroundColor = '#fff5f5';
        
        // Remove existing error message
        const existingError = element.parentNode.querySelector('.error-message');
        if (existingError) existingError.remove();
        
        // Add error message
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;
        errorDiv.style.cssText = 'color: #dc3545; font-size: 12px; margin-top: 5px;';
        
        element.parentNode.appendChild(errorDiv);
    }
    
    static markValid(element) {
        element.style.borderColor = '#28a745';
        element.style.backgroundColor = '#f8fff9';
        
        // Remove error message if exists
        const existingError = element.parentNode.querySelector('.error-message');
        if (existingError) existingError.remove();
    }
    
    // ==================== NOTIFICATION SYSTEM ====================
    
    static showNotification(message, type = 'info', duration = 5000) {
        // Remove existing notification
        const existing = document.querySelector('.utils-notification');
        if (existing) existing.remove();
        
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `utils-notification notification-${type}`;
        
        const icons = {
            success: 'check-circle',
            error: 'exclamation-circle',
            warning: 'exclamation-triangle',
            info: 'info-circle'
        };
        
        notification.innerHTML = `
            <i class="fas fa-${icons[type] || 'info-circle'}"></i>
            <span>${message}</span>
            <button class="notification-close">&times;</button>
        `;
        
        // Apply styles
        Object.assign(notification.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            background: this.getNotificationColor(type),
            color: 'white',
            padding: '15px 25px',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
            zIndex: '9999',
            animation: 'utilsSlideIn 0.3s ease',
            fontWeight: '500',
            minWidth: '300px',
            maxWidth: '500px'
        });
        
        // Close button styles
        const closeBtn = notification.querySelector('.notification-close');
        closeBtn.style.cssText = `
            background: none;
            border: none;
            color: white;
            font-size: 20px;
            cursor: pointer;
            margin-left: auto;
            padding: 0;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            transition: background 0.2s;
        `;
        
        closeBtn.addEventListener('mouseover', () => {
            closeBtn.style.background = 'rgba(255,255,255,0.2)';
        });
        
        closeBtn.addEventListener('mouseout', () => {
            closeBtn.style.background = 'none';
        });
        
        closeBtn.addEventListener('click', () => {
            notification.style.animation = 'utilsSlideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        });
        
        document.body.appendChild(notification);
        
        // Add animation styles if not exists
        if (!document.querySelector('#utils-notification-styles')) {
            const style = document.createElement('style');
            style.id = 'utils-notification-styles';
            style.textContent = `
                @keyframes utilsSlideIn {
                    from {
                        transform: translateX(100%);
                        opacity: 0;
                    }
                    to {
                        transform: translateX(0);
                        opacity: 1;
                    }
                }
                
                @keyframes utilsSlideOut {
                    from {
                        transform: translateX(0);
                        opacity: 1;
                    }
                    to {
                        transform: translateX(100%);
                        opacity: 0;
                    }
                }
            `;
            document.head.appendChild(style);
        }
        
        // Auto remove after duration
        if (duration > 0) {
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.style.animation = 'utilsSlideOut 0.3s ease';
                    setTimeout(() => notification.remove(), 300);
                }
            }, duration);
        }
        
        return notification;
    }
    
    static getNotificationColor(type) {
        const colors = {
            success: '#1dd1a1',
            error: '#ff6b6b',
            warning: '#ff9f43',
            info: '#54a0ff'
        };
        return colors[type] || '#54a0ff';
    }
    
    // ==================== DATA FORMATTING ====================
    
    static formatCurrency(amount, currency = 'USD') {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency
        }).format(amount);
    }
    
    static formatDate(dateString, format = 'medium') {
        if (!dateString) return 'N/A';
        
        const date = new Date(dateString);
        const formats = {
            short: { year: 'numeric', month: 'numeric', day: 'numeric' },
            medium: { year: 'numeric', month: 'short', day: 'numeric' },
            long: { year: 'numeric', month: 'long', day: 'numeric' }
        };
        
        return date.toLocaleDateString('en-US', formats[format] || formats.medium);
    }
    
    static formatDateTime(dateTimeString) {
        if (!dateTimeString) return 'N/A';
        
        const date = new Date(dateTimeString);
        return date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }
    
    static formatJobNumber(jobNo) {
        if (!jobNo) return '';
        // Ensure proper format: EOE/YYYY/NNNNN
        const parts = jobNo.split('/');
        if (parts.length === 3) {
            return `EOE/${parts[1]}/${parts[2].padStart(5, '0')}`;
        }
        return jobNo;
    }
    
    static generatePortSuggestions(query) {
        const ports = [
            "Jebel Ali Port, UAE",
            "Khalifa Port, UAE",
            "Mina Rashid, UAE",
            "Mina Zayed, UAE",
            "Hamad Port, Qatar",
            "Ruwais Port, Qatar",
            "Kuwait Port, Kuwait",
            "Shuwaikh Port, Kuwait",
            "King Abdulaziz Port, Saudi Arabia",
            "King Fahd Industrial Port, Saudi Arabia",
            "Jeddah Islamic Port, Saudi Arabia",
            "Port of Salalah, Oman",
            "Port Sultan Qaboos, Oman",
            "Mina Al Fahal, Oman",
            "Port of Bahrain, Bahrain",
            "Khalifa Bin Salman Port, Bahrain",
            "Port of Singapore, Singapore",
            "Port Klang, Malaysia",
            "Tanah Merah Port, Malaysia",
            "Port of Colombo, Sri Lanka",
            "Port of Karachi, Pakistan",
            "Port Qasim, Pakistan",
            "Nhava Sheva Port, India",
            "Mundra Port, India",
            "Chennai Port, India",
            "Kolkata Port, India",
            "Chittagong Port, Bangladesh",
            "Port of Hong Kong, China",
            "Port of Shanghai, China",
            "Port of Shenzhen, China",
            "Port of Busan, South Korea",
            "Port of Tokyo, Japan",
            "Port of Yokohama, Japan",
            "Port of Osaka, Japan",
            "Port of Rotterdam, Netherlands",
            "Port of Hamburg, Germany",
            "Port of Antwerp, Belgium",
            "Port of Felixstowe, UK",
            "Port of Le Havre, France",
            "Port of Genoa, Italy",
            "Port of Barcelona, Spain",
            "Port of Valencia, Spain",
            "Port of Piraeus, Greece",
            "Port of Istanbul, Turkey",
            "Port of Izmir, Turkey"
        ];
        
        if (!query) return ports.slice(0, 10);
        
        const queryLower = query.toLowerCase();
        return ports
            .filter(port => port.toLowerCase().includes(queryLower))
            .slice(0, 10);
    }
    
    // ==================== FORM DATA HANDLING ====================
    
    static serializeForm(formElement) {
        const formData = new FormData(formElement);
        const data = {};
        
        for (let [key, value] of formData.entries()) {
            data[key] = value;
        }
        
        return data;
    }
    
    static populateForm(formElement, data) {
        Object.keys(data).forEach(key => {
            const element = formElement.querySelector(`[name="${key}"]`);
            if (element) {
                if (element.type === 'checkbox' || element.type === 'radio') {
                    element.checked = data[key];
                } else {
                    element.value = data[key] || '';
                }
            }
        });
    }
    
    static clearForm(formElement) {
        formElement.reset();
        
        // Clear custom validation styles
        const inputs = formElement.querySelectorAll('input, select, textarea');
        inputs.forEach(input => {
            input.style.borderColor = '';
            input.style.backgroundColor = '';
            
            const errorDiv = input.parentNode.querySelector('.error-message');
            if (errorDiv) errorDiv.remove();
        });
    }
    
    // ==================== AUTOCOMPLETE HELPERS ====================
    
    static createAutocompleteDropdown(items, onSelect, options = {}) {
        const dropdown = document.createElement('div');
        dropdown.className = 'utils-autocomplete-dropdown';
        
        Object.assign(dropdown.style, {
            position: 'absolute',
            top: '100%',
            left: '0',
            right: '0',
            background: 'white',
            border: '1px solid #ddd',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            zIndex: '1000',
            maxHeight: '200px',
            overflowY: 'auto',
            marginTop: '5px'
        });
        
        if (items.length === 0) {
            const noResults = document.createElement('div');
            noResults.className = 'autocomplete-no-results';
            noResults.textContent = options.noResultsText || 'No results found';
            noResults.style.cssText = 'padding: 10px 15px; color: #666; font-style: italic;';
            dropdown.appendChild(noResults);
        } else {
            items.forEach((item, index) => {
                const itemElement = document.createElement('div');
                itemElement.className = 'utils-autocomplete-item';
                itemElement.dataset.index = index;
                
                itemElement.style.cssText = `
                    padding: 10px 15px;
                    cursor: pointer;
                    border-bottom: 1px solid #f0f0f0;
                    transition: background 0.2s;
                `;
                
                if (typeof item === 'string') {
                    itemElement.textContent = item;
                } else if (options.formatItem) {
                    itemElement.innerHTML = options.formatItem(item);
                } else {
                    itemElement.innerHTML = `
                        <strong>${item.name || item.value || item}</strong>
                        ${item.description ? `<small style="display: block; color: #666; margin-top: 2px;">${item.description}</small>` : ''}
                    `;
                }
                
                itemElement.addEventListener('mouseover', () => {
                    itemElement.style.background = '#f8f9fa';
                });
                
                itemElement.addEventListener('mouseout', () => {
                    itemElement.style.background = '';
                });
                
                itemElement.addEventListener('click', () => {
                    onSelect(item);
                });
                
                dropdown.appendChild(itemElement);
            });
        }
        
        return dropdown;
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    Utils.initialize().catch(console.error);
});