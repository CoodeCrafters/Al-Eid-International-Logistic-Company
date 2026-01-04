// Job Card JavaScript with Enhanced Features
class JobCardSystem {
    constructor() {
        this.currentJobCardId = null;
        this.init();
    }

    async init() {
        console.log('Initializing Job Card System...');
        
        // Initialize components
        this.initJobNumber();
        this.initDates();
        this.initForm();
        this.initPreview();
        this.initStats();
        
        // Setup event listeners
        this.setupEventListeners();
        
        // Update system time
        this.updateSystemTime();
        setInterval(() => this.updateSystemTime(), 1000);
        
        // Initialize database health check
        if (typeof Utils !== 'undefined') {
            Utils.initializeDatabaseHealthCheck();
        }
        
        console.log('Job Card System initialized');
    }

    initJobNumber() {
        const jobNoField = document.getElementById('jobNo');
        if (jobNoField) {
            // Generate initial job number
            this.generateJobNumber();
            
            // Start periodic refresh every 10 seconds
            this.startJobNumberRefresh();
        }
    }

    async generateJobNumber() {
        try {
            const jobNumber = await this.fetchNextJobNumber();
            if (jobNumber) {
                const jobNoField = document.getElementById('jobNo');
                if (jobNoField && (!jobNoField.value || jobNoField.value === 'EOE/')) {
                    jobNoField.value = jobNumber;
                    jobNoField.dataset.previewNumber = jobNumber;
                    
                    // Focus at end for editing
                    setTimeout(() => {
                        jobNoField.focus();
                        jobNoField.setSelectionRange(jobNumber.length, jobNumber.length);
                    }, 100);
                }
                return jobNumber;
            }
        } catch (error) {
            console.error('Error generating job number:', error);
            this.showFallbackJobNumber();
        }
    }

    async fetchNextJobNumber() {
        try {
            const response = await fetch('https://owns-memo-postal-duration.trycloudflare.com/api/jobcards/next-number');
            if (!response.ok) throw new Error('Failed to fetch job number');
            
            const data = await response.json();
            console.log('Next job number response:', data);
            
            if (data.nextJobNumber) {
                return data.nextJobNumber;
            }
            
            throw new Error('No job number received');
        } catch (error) {
            console.error('Error fetching job number:', error);
            throw error;
        }
    }

    showFallbackJobNumber() {
        const jobNoField = document.getElementById('jobNo');
        if (jobNoField) {
            const year = new Date().getFullYear();
            const timestamp = Date.now().toString().slice(-6);
            const fallbackNumber = `EOE/${year}/${timestamp.padStart(5, '0')}`;
            
            jobNoField.value = fallbackNumber;
            jobNoField.dataset.previewNumber = fallbackNumber;
            
            this.showNotification('Using temporary job number. Save to get permanent number.', 'info');
        }
    }

    startJobNumberRefresh() {
        // Fetch immediately
        this.fetchNextJobNumber();
        
        // Then fetch every 10 seconds
        setInterval(() => this.fetchNextJobNumber(), 10000);
        
        console.log('Job number refresh interval started: 10 seconds');
    }

    initDates() {
        const now = new Date();
        
        // Set current date
        const dateField = document.getElementById('date');
        if (dateField) {
            dateField.value = now.toISOString().split('T')[0];
        }
        
        // Set ESTD to tomorrow 9 AM
        const estdField = document.getElementById('estd');
        if (estdField) {
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9, 0, 0, 0);
            estdField.value = tomorrow.toISOString().slice(0, 16);
        }
        
        // Set ETA to 3 days from now 9 AM
        const etaField = document.getElementById('eta');
        if (etaField) {
            const inThreeDays = new Date(now);
            inThreeDays.setDate(inThreeDays.getDate() + 3);
            inThreeDays.setHours(9, 0, 0, 0);
            etaField.value = inThreeDays.toISOString().slice(0, 16);
        }
        
        // Set Bayan date to current date
        const bayanDateField = document.getElementById('bayanDate');
        if (bayanDateField) {
            bayanDateField.value = now.toISOString().split('T')[0];
        }
    }

    initForm() {
        const form = document.getElementById('jobCardForm');
        if (form) {
            form.addEventListener('submit', (e) => this.handleSubmit(e));
        }
        
        // Initialize autocomplete for customer fields
        this.initAutocomplete();
    }

    initAutocomplete() {
        // Customer name autocomplete
        const customerNameField = document.getElementById('customerName');
        if (customerNameField) {
            customerNameField.addEventListener('input', (e) => this.handleCustomerSearch(e));
        }
        
        // Shipper name autocomplete
        const shipperNameField = document.getElementById('shipperName');
        if (shipperNameField) {
            shipperNameField.addEventListener('input', (e) => this.handleShipperSearch(e));
        }
    }

    async handleCustomerSearch(event) {
        const query = event.target.value.trim();
        if (query.length < 2) return;
        
        // Debounce search
        clearTimeout(this.customerSearchTimeout);
        this.customerSearchTimeout = setTimeout(async () => {
            try {
                const response = await fetch(
                    `https://owns-memo-postal-duration.trycloudflare.com/api/customers/search?q=${encodeURIComponent(query)}`
                );
                
                if (response.ok) {
                    const customers = await response.json();
                    this.showCustomerDropdown(customers, event.target);
                }
            } catch (error) {
                console.error('Customer search error:', error);
            }
        }, 300);
    }

    showCustomerDropdown(customers, inputField) {
        // Remove existing dropdown
        this.removeDropdown();
        
        if (customers.length === 0) return;
        
        const dropdown = document.createElement('div');
        dropdown.className = 'autocomplete-dropdown';
        dropdown.innerHTML = `
            <div class="dropdown-header">
                <i class="fas fa-search"></i>
                <input type="text" placeholder="Search customers..." class="dropdown-search">
            </div>
            <div class="dropdown-items">
                ${customers.map(customer => `
                    <div class="dropdown-item" data-customer='${JSON.stringify(customer)}'>
                        <strong>${customer.name}</strong>
                        <small>${customer.company || 'No company'}</small>
                    </div>
                `).join('')}
            </div>
        `;
        
        // Position dropdown
        const rect = inputField.getBoundingClientRect();
        dropdown.style.position = 'absolute';
        dropdown.style.top = `${rect.bottom + window.scrollY}px`;
        dropdown.style.left = `${rect.left + window.scrollX}px`;
        dropdown.style.width = `${rect.width}px`;
        dropdown.style.zIndex = '1000';
        
        document.body.appendChild(dropdown);
        
        // Add click handler for items
        dropdown.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const customer = JSON.parse(item.dataset.customer);
                this.selectCustomer(customer);
                this.removeDropdown();
            });
        });
        
        // Handle search within dropdown
        const searchInput = dropdown.querySelector('.dropdown-search');
        searchInput.addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase();
            const items = dropdown.querySelectorAll('.dropdown-item');
            
            items.forEach(item => {
                const text = item.textContent.toLowerCase();
                item.style.display = text.includes(searchTerm) ? '' : 'none';
            });
        });
        
        // Store reference
        this.currentDropdown = dropdown;
        
        // Close dropdown on outside click
        setTimeout(() => {
            document.addEventListener('click', (e) => {
                if (!dropdown.contains(e.target) && e.target !== inputField) {
                    this.removeDropdown();
                }
            }, { once: true });
        });
    }

    selectCustomer(customer) {
        // Fill customer fields
        document.getElementById('customerName').value = customer.name;
        document.getElementById('customerRefNo').value = customer.reference_number || '';
        document.getElementById('customerAddress').value = customer.address || '';
        document.getElementById('email').value = customer.email || '';
        document.getElementById('phone').value = customer.phone || '';
        
        // Update preview
        this.updatePreview();
    }

    removeDropdown() {
        if (this.currentDropdown) {
            this.currentDropdown.remove();
            this.currentDropdown = null;
        }
    }

    async handleShipperSearch(event) {
        const query = event.target.value.trim();
        if (query.length < 2) return;
        
        clearTimeout(this.shipperSearchTimeout);
        this.shipperSearchTimeout = setTimeout(async () => {
            try {
                const response = await fetch(
                    `https://owns-memo-postal-duration.trycloudflare.com/api/shippers/search?q=${encodeURIComponent(query)}`
                );
                
                if (response.ok) {
                    const shippers = await response.json();
                    this.showShipperDropdown(shippers, event.target);
                }
            } catch (error) {
                console.error('Shipper search error:', error);
            }
        }, 300);
    }

    showShipperDropdown(shippers, inputField) {
        // Similar implementation to customer dropdown
        this.removeDropdown();
        
        if (shippers.length === 0) return;
        
        const dropdown = document.createElement('div');
        dropdown.className = 'autocomplete-dropdown';
        dropdown.innerHTML = `
            <div class="dropdown-items">
                ${shippers.map(shipper => `
                    <div class="dropdown-item" data-shipper='${JSON.stringify(shipper)}'>
                        <strong>${shipper.name}</strong>
                        <small>${shipper.company || 'No company'}</small>
                    </div>
                `).join('')}
            </div>
        `;
        
        // Position dropdown
        const rect = inputField.getBoundingClientRect();
        dropdown.style.position = 'absolute';
        dropdown.style.top = `${rect.bottom + window.scrollY}px`;
        dropdown.style.left = `${rect.left + window.scrollX}px`;
        dropdown.style.width = `${rect.width}px`;
        dropdown.style.zIndex = '1000';
        
        document.body.appendChild(dropdown);
        
        // Add click handler
        dropdown.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const shipper = JSON.parse(item.dataset.shipper);
                this.selectShipper(shipper);
                this.removeDropdown();
            });
        });
        
        this.currentDropdown = dropdown;
        
        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', (e) => {
                if (!dropdown.contains(e.target) && e.target !== inputField) {
                    this.removeDropdown();
                }
            }, { once: true });
        });
    }

    selectShipper(shipper) {
        document.getElementById('shipperName').value = shipper.name;
        document.getElementById('shipperRefNo').value = shipper.reference_number || '';
        this.updatePreview();
    }

    initPreview() {
        // Setup real-time preview updates
        const formElements = document.querySelectorAll('#jobCardForm input, #jobCardForm select, #jobCardForm textarea');
        formElements.forEach(element => {
            element.addEventListener('input', () => this.updatePreview());
            element.addEventListener('change', () => this.updatePreview());
        });
        
        // Initial preview
        this.updatePreview();
    }

    updatePreview() {
        const previewDiv = document.getElementById('jobCardPreview');
        if (!previewDiv) return;
        
        // Collect form data
        const formData = this.collectFormData();
        
        // Check if form is empty
        const isEmpty = Object.values(formData).every(value => 
            !value || value === '' || value === 'Not Set'
        );
        
        if (isEmpty) {
            previewDiv.innerHTML = `
                <div class="preview-placeholder">
                    <div class="loading-spinner">
                        <i class="fas fa-clipboard-list"></i>
                    </div>
                    <p>Fill the form to see preview</p>
                    <small class="text-muted">Preview updates in real-time</small>
                </div>
            `;
            return;
        }
        
        // Generate preview HTML
        previewDiv.innerHTML = this.generatePreviewHTML(formData);
    }

    collectFormData() {
        const fields = [
            'jobNo', 'date', 'modeOfTravel', 'shipmentType', 'estd', 'eta',
            'portArrival', 'costCenter', 'customerRefNo', 'requesterName',
            'customerName', 'customerAddress', 'email', 'phone',
            'truckWaybillNo', 'shipperName', 'shipperRefNo', 'bayanNo',
            'bayanDate', 'grossWeight', 'packages', 'packageType',
            'description', 'specialInstructions'
        ];
        
        const data = {};
        fields.forEach(field => {
            const element = document.getElementById(field);
            data[field] = element ? element.value : '';
        });
        
        return data;
    }

    generatePreviewHTML(data) {
        const formatDate = (dateString) => {
            if (!dateString) return 'Not Set';
            try {
                return new Date(dateString).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                });
            } catch (e) {
                return dateString;
            }
        };
        
        const formatDateTime = (dateTimeString) => {
            if (!dateTimeString) return 'Not Set';
            try {
                return new Date(dateTimeString).toLocaleString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } catch (e) {
                return dateTimeString;
            }
        };
        
        return `
            <div class="preview-content">
                <div class="preview-header-card">
                    <div>
                        <h4>Job Card Preview</h4>
                        <small class="text-muted">${formatDate(data.date)}</small>
                    </div>
                    <div class="preview-id">${data.jobNo || 'Not Set'}</div>
                </div>
                
                <div class="preview-details">
                    <div class="row">
                        <div class="col-md-6">
                            <div class="preview-item">
                                <label>Customer</label>
                                <strong>${data.customerName || 'Not Set'}</strong>
                            </div>
                            <div class="preview-item">
                                <label>Reference No</label>
                                <span>${data.customerRefNo || 'Not Set'}</span>
                            </div>
                            <div class="preview-item">
                                <label>Shipment Type</label>
                                <span class="badge bg-info">${data.shipmentType || 'Not Set'}</span>
                            </div>
                            <div class="preview-item">
                                <label>Mode of Travel</label>
                                <span class="badge bg-primary">${data.modeOfTravel || 'Not Set'}</span>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <div class="preview-item">
                                <label>ESTD</label>
                                <span>${formatDateTime(data.estd)}</span>
                            </div>
                            <div class="preview-item">
                                <label>ETA</label>
                                <span>${formatDateTime(data.eta)}</span>
                            </div>
                            <div class="preview-item">
                                <label>Port of Arrival</label>
                                <span>${data.portArrival || 'Not Set'}</span>
                            </div>
                            <div class="preview-item">
                                <label>Cost Center</label>
                                <span>${data.costCenter || 'Not Set'}</span>
                            </div>
                        </div>
                    </div>
                    
                    <div class="preview-section">
                        <h6>Shipping Details</h6>
                        <div class="row">
                            <div class="col-md-6">
                                <div class="preview-item">
                                    <label>Shipper</label>
                                    <span>${data.shipperName || 'Not Set'}</span>
                                </div>
                                <div class="preview-item">
                                    <label>Bayan No</label>
                                    <span>${data.bayanNo || 'Not Set'}</span>
                                </div>
                            </div>
                            <div class="col-md-6">
                                <div class="preview-item">
                                    <label>Weight</label>
                                    <span>${data.grossWeight || '0'} kg</span>
                                </div>
                                <div class="preview-item">
                                    <label>Packages</label>
                                    <span>${data.packages || '0'} ${data.packageType || ''}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    ${data.description ? `
                        <div class="preview-section">
                            <h6>Description</h6>
                            <p>${data.description.substring(0, 150)}${data.description.length > 150 ? '...' : ''}</p>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    async initStats() {
        try {
            const response = await fetch('https://owns-memo-postal-duration.trycloudflare.com/api/stats/jobcards');
            if (response.ok) {
                const stats = await response.json();
                
                const invoiceCount = document.getElementById('invoiceCount');
                const jobcardCount = document.getElementById('jobcardCount');
                
                if (invoiceCount) invoiceCount.textContent = stats.totalInvoices || '0';
                if (jobcardCount) jobcardCount.textContent = stats.totalJobCards || '0';
            }
        } catch (error) {
            console.log('Could not load stats:', error);
        }
    }

    setupEventListeners() {
        // Add any additional event listeners here
    }

    updateSystemTime() {
        const now = new Date();
        
        const timeElement = document.getElementById('systemTime');
        if (timeElement) {
            timeElement.textContent = now.toLocaleTimeString('en-US', { 
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        }
        
        const dateElement = document.getElementById('systemDate');
        if (dateElement) {
            dateElement.textContent = now.toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        }
    }

    async handleSubmit(event) {
        event.preventDefault();
        
        const form = document.getElementById('jobCardForm');
        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }
        
        const jobNoField = document.getElementById('jobNo');
        if (!jobNoField.value || jobNoField.value === 'EOE/') {
            this.showNotification('Job number is required.', 'error');
            jobNoField.focus();
            return;
        }
        
        const formData = this.collectFormData();
        
        // Add metadata
        formData.status = 'submitted';
        formData.submittedAt = new Date().toISOString();
        formData.submittedBy = document.getElementById('userName')?.textContent || 'Unknown';
        
        if (this.currentJobCardId) {
            formData.id = this.currentJobCardId;
        }
        
        const submitBtn = form.querySelector('button[type="submit"]');
        const originalText = submitBtn.innerHTML;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
        submitBtn.disabled = true;
        
        try {
            const response = await fetch('https://owns-memo-postal-duration.trycloudflare.com/api/jobcards/submit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData)
            });
            
            if (response.ok) {
                const result = await response.json();
                
                // Make job number read-only
                jobNoField.readOnly = true;
                
                // Show success message
                this.showSuccessWidget(result.jobNumber || formData.jobNo);
                
                // Reset form after delay
                setTimeout(() => {
                    this.resetForm();
                    this.updateStats();
                }, 3000);
            } else {
                throw new Error('Submission failed');
            }
        } catch (error) {
            this.showNotification('Error submitting job card: ' + error.message, 'error');
        } finally {
            submitBtn.innerHTML = originalText;
            submitBtn.disabled = false;
        }
    }

    async saveJobCard() {
        const form = document.getElementById('jobCardForm');
        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }
        
        const jobNoField = document.getElementById('jobNo');
        if (!jobNoField.value || jobNoField.value === 'EOE/') {
            await this.generateJobNumber();
            if (!jobNoField.value || jobNoField.value === 'EOE/') {
                this.showNotification('Please wait for job number generation.', 'error');
                return;
            }
        }
        
        const formData = this.collectFormData();
        formData.status = 'draft';
        formData.createdAt = new Date().toISOString();
        formData.createdBy = document.getElementById('userName')?.textContent || 'Unknown';
        
        const saveBtn = document.querySelector('button[onclick="saveJobCard()"]');
        const originalText = saveBtn.innerHTML;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        saveBtn.disabled = true;
        
        try {
            const response = await fetch('https://owns-memo-postal-duration.trycloudflare.com/api/jobcards/save-draft', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData)
            });
            
            if (response.ok) {
                const result = await response.json();
                
                if (result.jobNumber && result.jobNumber !== jobNoField.value) {
                    jobNoField.value = result.jobNumber;
                }
                
                this.currentJobCardId = result.id;
                jobNoField.readOnly = true;
                
                this.showNotification('Job Card saved as draft successfully!', 'success');
            } else {
                throw new Error('Failed to save draft');
            }
        } catch (error) {
            this.showNotification('Error saving draft: ' + error.message, 'error');
        } finally {
            saveBtn.innerHTML = originalText;
            saveBtn.disabled = false;
        }
    }

    resetForm() {
        if (confirm('Are you sure you want to reset the form? All entered data will be lost.')) {
            const form = document.getElementById('jobCardForm');
            const jobNoField = document.getElementById('jobNo');
            
            const currentJobNo = jobNoField.value;
            
            form.reset();
            this.currentJobCardId = null;
            
            if (currentJobNo && currentJobNo.startsWith('EOE/')) {
                jobNoField.value = currentJobNo;
                jobNoField.readOnly = false;
            } else {
                this.generateJobNumber();
            }
            
            this.initDates();
            this.updatePreview();
            this.showNotification('Form has been reset', 'info');
        }
    }

    async generateInvoice() {
        const form = document.getElementById('jobCardForm');
        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }
        
        const requiredFields = ['jobNo', 'customerName', 'customerRefNo', 'grossWeight', 'packages'];
        const missingFields = requiredFields.filter(field => !document.getElementById(field).value);
        
        if (missingFields.length > 0) {
            this.showNotification('Please fill all required fields before generating invoice.', 'error');
            return;
        }
        
        if (!this.currentJobCardId) {
            await this.saveJobCard();
            if (!this.currentJobCardId) {
                this.showNotification('Please save the job card first.', 'error');
                return;
            }
        }
        
        const formData = this.collectFormData();
        
        try {
            const response = await fetch('https://owns-memo-postal-duration.trycloudflare.com/api/jobcards/generate-invoice', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    jobCardId: this.currentJobCardId,
                    jobCardData: formData
                })
            });
            
            if (response.ok) {
                const result = await response.json();
                
                // Store data and redirect
                sessionStorage.setItem('currentJobCard', JSON.stringify(formData));
                sessionStorage.setItem('invoiceData', JSON.stringify(result));
                
                window.location.href = 'invoice-generator.html';
            } else {
                throw new Error('Failed to generate invoice');
            }
        } catch (error) {
            this.showNotification('Error generating invoice: ' + error.message, 'error');
        }
    }

    showNotification(message, type = 'info') {
        // Remove existing notification
        const existing = document.querySelector('.modern-notification-widget');
        if (existing) existing.remove();
        
        let icon, title, backgroundColor;
        
        switch(type) {
            case 'success':
                icon = 'fa-check-circle';
                title = 'SUCCESS';
                backgroundColor = '#10b981';
                break;
            case 'error':
                icon = 'fa-exclamation-circle';
                title = 'ERROR';
                backgroundColor = '#ef4444';
                break;
            default:
                icon = 'fa-info-circle';
                title = 'INFO';
                backgroundColor = '#3b82f6';
        }
        
        const notification = document.createElement('div');
        notification.className = 'modern-notification-widget';
        notification.innerHTML = `
            <div class="notification-content">
                <div class="notification-icon">
                    <i class="fas ${icon}"></i>
                </div>
                <div class="notification-body">
                    <h4>${title}</h4>
                    <p>${message}</p>
                </div>
                <button class="notification-close">&times;</button>
            </div>
        `;
        
        document.body.appendChild(notification);
        
        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 5000);
        
        // Close button
        notification.querySelector('.notification-close').addEventListener('click', () => {
            notification.remove();
        });
    }

    showSuccessWidget(jobNumber) {
        const widget = document.createElement('div');
        widget.className = 'success-widget';
        widget.innerHTML = `
            <div class="success-content">
                <div class="success-icon">
                    <i class="fas fa-check-circle"></i>
                </div>
                <div class="success-details">
                    <h4>Job Card Submitted Successfully!</h4>
                    <p>Job Number: <strong>${jobNumber}</strong></p>
                    <p>Your job card has been submitted and is being processed.</p>
                    <div class="success-actions">
                        <button class="btn btn-light" onclick="this.closest('.success-widget').remove()">
                            Continue
                        </button>
                        <button class="btn btn-primary" onclick="window.print()">
                            <i class="fas fa-print"></i> Print
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        document.querySelector('.content-area').insertBefore(widget, document.querySelector('.two-column-layout'));
        
        // Auto-remove after 8 seconds
        setTimeout(() => {
            if (widget.parentNode) {
                widget.remove();
            }
        }, 8000);
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.jobCardSystem = new JobCardSystem();
});

// Global functions for onclick handlers
function saveJobCard() {
    if (window.jobCardSystem) {
        window.jobCardSystem.saveJobCard();
    }
}

function resetForm() {
    if (window.jobCardSystem) {
        window.jobCardSystem.resetForm();
    }
}

function generateInvoice() {
    if (window.jobCardSystem) {
        window.jobCardSystem.generateInvoice();
    }
}