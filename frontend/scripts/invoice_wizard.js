// Import SidebarManager from sidebar.js
import { SidebarManager } from './sidebar.js';

// Wizard JavaScript - attach to window object
window.wizardData = {
    jobData: null,
    chargeTypes: [],
    requiredChargeCounter: 1,
    marginalChargeCounter: 1,
    requiredCharges: [],
    marginalCharges: []
};

// Define all functions BEFORE using them
window.loadUserData = function() {
    try {
        const userData = sessionStorage.getItem('pos_user');
        if (userData) {
            const user = JSON.parse(userData);
            const userName = document.getElementById('userName');
            const userRole = document.getElementById('userRole');
            
            if (userName) userName.textContent = user.name || 'User';
            if (userRole) userRole.textContent = user.role || 'User';
        }
    } catch (error) {
        console.error('Error loading user data:', error);
    }
};

// Add this function to load charge types
// Add this function to load charge types
async function loadChargeTypes() {
    try {
        // Use Utils.getApiBaseUrl() to get the correct backend URL
        const apiBaseUrl = window.CONFIG?.API_BASE_URL || 'http://localhost:5000';
        console.log('Fetching charge types from:', apiBaseUrl);
        
        const response = await fetch(`${apiBaseUrl}/api/charges/types`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (result.success) {
            console.log('Loaded charge types:', result.data);
            window.wizardData.chargeTypes = result.data;
        } else {
            console.warn('Failed to load charge types:', result.message);
        }
    } catch (error) {
        console.error('Failed to load charge types:', error);
        // Fallback to default charges if API fails
        window.wizardData.chargeTypes = [
            { id: '1', name: 'General Merchandise (Purchase)' },
            { id: '2', name: 'Repair & Return Approval Charges' },
            { id: '3', name: 'Normal Bayan Charges' },
            { id: '4', name: 'Filling Original Custom Documents' },
            { id: '5', name: 'Handling Charges' },
            { id: '6', name: 'Air Port Handling Charges' },
            { id: '7', name: 'Global Clearance House System Charges' },
            { id: '8', name: 'Stamp' },
            { id: '9', name: 'Transportation Charges' },
            { id: '10', name: 'Legalization Charges' },
            { id: '11', name: 'MOFA Legalization Service Charges' },
            { id: '12', name: 'MOFA Legalization Charges' },
            { id: '13', name: 'COC Legalization Service Charges' },
            { id: '14', name: 'COC Legalization Charges' },
            { id: '15', name: 'Customs Clearance Service Charges' },
            { id: '16', name: 'PAI Approval Charges' },
            { id: '17', name: 'Inspection Charges' },
            { id: '18', name: 'DO Collection Service Charges' },
            { id: '19', name: 'MOH Approval' },
            { id: '20', name: 'Cross Docking Charges' },
            { id: '21', name: 'Cost of Damaged Items' },
            { id: '22', name: 'Custom Duty' },
            { id: '23', name: 'Transloading Charges' },
            { id: '24', name: 'Cost of Goods Service' },
            { id: '25', name: 'Direct Cost, Purchase' },
            { id: '26', name: 'Direct Cost, Purchase (Adj-chg)' },
            { id: '27', name: 'Freight Charges (Sea)' },
            { id: '28', name: 'Freight Charges (Air)' },
            { id: '29', name: 'Freight Charges (Land)' },
            { id: '30', name: 'Ocean Freight' },
            { id: '31', name: 'Air Freight' },
            { id: '32', name: 'Road Freight' },
            { id: '33', name: 'FCL Charges' },
            { id: '34', name: 'LCL Charges' },
            { id: '35', name: 'THC (Terminal Handling Charges)' },
            { id: '36', name: 'Documentation Charges' },
            { id: '37', name: 'Bill of Lading Fee' },
            { id: '38', name: 'Air Waybill Fee' }
        ];
    }
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', async function() {
    // Initialize Sidebar
    window.sidebarManager = new SidebarManager();
    
    // Load user data for sidebar
    window.loadUserData();
    
    // Load charge types from backend
    await loadChargeTypes();
    
    // Now initialize the wizard
    window.initializeWizard();
});

window.initializeWizard = function() {
    // Parse URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const jobCardParam = urlParams.get('jobCard');
    const chargeTypesParam = urlParams.get('chargeTypes');
    
    if (jobCardParam) {
        try {
            window.wizardData.jobData = JSON.parse(decodeURIComponent(jobCardParam));
            window.initializeJobInfo();
        } catch (e) {
            console.error('Error parsing job data:', e);
            window.showError('Invalid job data');
        }
    }
    
    if (chargeTypesParam) {
        try {
            window.wizardData.chargeTypes = JSON.parse(decodeURIComponent(chargeTypesParam));
        } catch (e) {
            console.error('Error parsing charge types:', e);
        }
    }
    
    // Set today's date as default payment date
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('paymentDate').value = today;
    
    // Add event listeners
    document.getElementById('addRequiredChargeBtn').addEventListener('click', () => window.addChargeRow('required'));
    document.getElementById('addMarginalChargeBtn').addEventListener('click', () => window.addChargeRow('marginal'));
    document.getElementById('advanceAmount').addEventListener('input', window.updateTotals);
    document.getElementById('cancelBtn').addEventListener('click', window.cancelWizard);
    document.getElementById('saveBtn').addEventListener('click', () => window.saveInvoice(false));
    document.getElementById('saveAndGenerateBtn').addEventListener('click', () => window.saveInvoice(true));
    
    // Add initial charge rows
    window.addChargeRow('required');
    window.addChargeRow('marginal');
    
    // Set page title
    if (window.wizardData.jobData) {
        document.title = `Charges Wizard - ${window.wizardData.jobData.job_no}`;
    }
    
    // Initialize totals
    window.updateTotals();
};

window.initializeJobInfo = function() {
    if (!window.wizardData.jobData) return;
    
    const subtitle = document.getElementById('jobInfoSubtitle');
    subtitle.textContent = `Manage charges and advance payment for ${window.wizardData.jobData.job_no}`;
    
    const infoGrid = document.getElementById('jobInfoGrid');
    const infoCards = [
        {
            label: 'Job Number',
            value: window.wizardData.jobData.job_no || 'N/A',
            icon: 'fa-hashtag'
        },
        {
            label: 'Invoice Number',
            value: window.wizardData.jobData.invoice_no || 'N/A',
            icon: 'fa-briefcase'
        },
        {
            label: 'Customer',
            value: window.wizardData.jobData.customer_name || 'N/A',
            icon: 'fa-user-tie'
        },
        {
            label: 'Route',
            value: `${window.wizardData.jobData.departure_location || 'N/A'} → ${window.wizardData.jobData.arrival_location || 'N/A'}`,
            icon: 'fa-route'
        },
        {
            label: 'Shipper',
            value: window.wizardData.jobData.shipper_name || 'N/A',
            icon: 'fa-truck-loading'
        },
        {
            label: window.wizardData.jobData.type === 'SEA' ? 'HBL Number' : 
                   window.wizardData.jobData.type === 'AIR' ? 'HAWB Number' : 'Waybill',
            value: window.wizardData.jobData.hbl || window.wizardData.jobData.habw || window.wizardData.jobData.truck_waybill_no || 'N/A',
            icon: 'fa-file-contract'
        },
        {
            label: 'Status',
            value: window.getStatusDisplay(window.wizardData.jobData.status),
            icon: 'fa-circle-info'
        }
    ];
    
    infoCards.forEach(card => {
        const cardHtml = `
            <div class="info-card">
                <div class="info-label">
                    <i class="fa-solid ${card.icon}"></i> ${card.label}
                </div>
                <div class="info-value">${card.value}</div>
            </div>
        `;
        infoGrid.insertAdjacentHTML('beforeend', cardHtml);
    });
};

window.getStatusDisplay = function(status) {
    const statusMap = {
        'draft': 'Draft',
        'submitted': 'Submitted',
        'approved': 'Approved',
        'completed': 'Completed',
        'cancelled': 'Cancelled'
    };
    return statusMap[status] || status;
};

// In your sidebar toggle function
window.toggleSidebar = function() {
    const sidebar = document.getElementById('sidebar');
    const header = document.getElementById('mainHeader');
    
    sidebar.classList.toggle('collapsed');
    
    // Force update header position
    if (sidebar.classList.contains('collapsed')) {
        header.style.left = '70px';
    } else {
        header.style.left = '240px';
    }
};

window.setupChargeRowEvents = function(row, type) {
    // Description change
    const descriptionSelect = row.querySelector('.charge-description');
    const customInput = row.querySelector('.custom-description');
    
    descriptionSelect.addEventListener('change', function() {
        if (this.value === 'custom') {
            customInput.style.display = 'block';
            customInput.focus();
        } else {
            customInput.style.display = 'none';
            customInput.value = '';
        }
    });
    
    // Custom description input
    customInput.addEventListener('input', function() {
        if (this.value) {
            descriptionSelect.value = 'custom';
        }
    });
    
    // Quantity and rate inputs
    const quantityInput = row.querySelector('.charge-quantity');
    const rateInput = row.querySelector('.charge-rate');
    
    const calculateRowAmount = () => {
        const quantity = parseFloat(quantityInput.value) || 0;
        const rate = parseFloat(rateInput.value) || 0;
        const amount = quantity * rate;
        row.querySelector('.charge-amount').value = amount.toFixed(3);
        window.updateTotals();
    };
    
    quantityInput.addEventListener('input', calculateRowAmount);
    rateInput.addEventListener('input', calculateRowAmount);
    
    // Remove button - update data storage
    const removeBtn = row.querySelector('.remove-charge-btn');
    removeBtn.addEventListener('click', function() {
        row.remove();
        window.updateTotals();
    });
};

window.addChargeRow = function(type) {
    const tableBodyId = type === 'required' ? 'requiredChargesTableBody' : 'marginalChargesTableBody';
    const counter = type === 'required' ? window.wizardData.requiredChargeCounter++ : window.wizardData.marginalChargeCounter++;
    
    const tableBody = document.getElementById(tableBodyId);
    const template = document.getElementById('chargeRowTemplate').innerHTML;
    
    // Prepare charge options - you can customize for each type
    let chargeOptions = '<option value="">Select charge type</option>';
    
    // Add default charge types
    window.wizardData.chargeTypes.forEach(typeOption => {
        chargeOptions += `<option value="${typeOption.name || typeOption.charge_name}">${typeOption.name || typeOption.charge_name}</option>`;
    });
    
    // Add custom option
    chargeOptions += '<option value="custom">Custom...</option>';
    
    // Add specific options for marginal charges
    if (type === 'marginal') {
        chargeOptions += '<option value="Profit Margin">Profit Margin</option>';
        chargeOptions += '<option value="Service Fee">Service Fee</option>';
        chargeOptions += '<option value="Administration Fee">Administration Fee</option>';
    }
    
    // Replace placeholders in template
    let rowHtml = template
        .replace('{{#each chargeTypes}}', '')
        .replace('{{/each}}', '')
        .replace(/{{chargeTypes}}/g, chargeOptions)
        .replace(/{{id}}/g, `${type}-${counter}`);
    
    tableBody.insertAdjacentHTML('beforeend', rowHtml);
    
    // Get the new row
    const newRow = tableBody.lastElementChild;
    
    // Add event listeners to the new row
    window.setupChargeRowEvents(newRow, type);
    
    // Update totals
    window.updateTotals();
};

window.updateTotals = function() {
    let requiredSubtotal = 0;
    let marginalSubtotal = 0;
    
    // Calculate required charges subtotal
    document.querySelectorAll('#requiredChargesTableBody .charge-amount').forEach(input => {
        requiredSubtotal += parseFloat(input.value) || 0;
    });
    
    // Calculate marginal charges subtotal
    document.querySelectorAll('#marginalChargesTableBody .charge-amount').forEach(input => {
        marginalSubtotal += parseFloat(input.value) || 0;
    });
    
    const totalCharges = requiredSubtotal + marginalSubtotal;
    
    // Get advance payment
    const advanceAmount = parseFloat(document.getElementById('advanceAmount').value) || 0;
    
    // Calculate tax (0% for now)
    const taxRate = 0;
    const taxAmount = totalCharges * taxRate;
    
    // Calculate balance due
    const balanceDue = totalCharges - advanceAmount;
    
    // Update subtotal display
    document.getElementById('requiredSubtotal').textContent = requiredSubtotal.toFixed(3) + ' KWD';
    document.getElementById('marginalSubtotal').textContent = marginalSubtotal.toFixed(3) + ' KWD';
    document.getElementById('totalChargesSum').textContent = totalCharges.toFixed(3) + ' KWD';
    
    // Update main totals display (keep your existing panel updates)
    document.getElementById('totalCharges').textContent = totalCharges.toFixed(3);
    document.getElementById('totalAdvance').textContent = advanceAmount.toFixed(3);
    document.getElementById('totalTax').textContent = taxAmount.toFixed(3);
    document.getElementById('balanceDue').textContent = balanceDue.toFixed(3);
};

window.showLoading = function(message = 'Processing...') {
    document.getElementById('loadingText').textContent = message;
    document.getElementById('loadingOverlay').classList.add('active');
};

window.hideLoading = function() {
    document.getElementById('loadingOverlay').classList.remove('active');
};

window.showSuccess = function(message = 'Operation completed successfully!') {
    const successMsg = document.getElementById('successMessage');
    successMsg.querySelector('span').textContent = message;
    successMsg.classList.add('show');
    
    setTimeout(() => {
        successMsg.classList.remove('show');
    }, 3000);
};

window.showError = function(message = 'An error occurred!') {
    const errorMsg = document.getElementById('errorMessage');
    errorMsg.querySelector('span').textContent = message;
    errorMsg.classList.add('show');
    
    setTimeout(() => {
        errorMsg.classList.remove('show');
    }, 5000);
};

window.cancelWizard = function() {
    if (confirm('Are you sure you want to cancel? Any unsaved changes will be lost.')) {
        window.history.back();
    }
};

window.saveInvoice = async function(generatePDF = false) {
    try {
        window.showLoading('Saving invoice...');
        
        if (!window.wizardData.jobData) {
            window.showError('Job data not found');
            window.hideLoading();
            return;
        }
        
        // Collect required charges
        const requiredCharges = [];
        let hasEmptyRequiredDescription = false;
        
        document.querySelectorAll('#requiredChargesTableBody tr[data-charge-id]').forEach(row => {
            const descriptionSelect = row.querySelector('.charge-description');
            const customInput = row.querySelector('.custom-description');
            let description = '';
            
            if (descriptionSelect.value === 'custom') {
                description = customInput.value.trim();
            } else {
                description = descriptionSelect.value;
            }
            
            if (!description) {
                hasEmptyRequiredDescription = true;
                descriptionSelect.focus();
                return;
            }
            
            const quantity = parseFloat(row.querySelector('.charge-quantity').value) || 0;
            const unit = row.querySelector('.charge-unit').value.trim() || 'each';
            const rate = parseFloat(row.querySelector('.charge-rate').value) || 0;
            const amount = parseFloat(row.querySelector('.charge-amount').value) || 0;
            
            if (quantity <= 0 || rate <= 0) {
                window.showError('Quantity and unit price must be greater than 0 for required charges');
                window.hideLoading();
                return;
            }
            
            requiredCharges.push({
                type: 'required',
                description,
                quantity,
                unit,
                rate,
                amount
            });
        });
        
        if (hasEmptyRequiredDescription) {
            window.showError('Please enter description for all required charges');
            window.hideLoading();
            return;
        }
        
        // Collect marginal charges
        const marginalCharges = [];
        let hasEmptyMarginalDescription = false;
        
        document.querySelectorAll('#marginalChargesTableBody tr[data-charge-id]').forEach(row => {
            const descriptionSelect = row.querySelector('.charge-description');
            const customInput = row.querySelector('.custom-description');
            let description = '';
            
            if (descriptionSelect.value === 'custom') {
                description = customInput.value.trim();
            } else {
                description = descriptionSelect.value;
            }
            
            if (!description) {
                hasEmptyMarginalDescription = true;
                descriptionSelect.focus();
                return;
            }
            
            const quantity = parseFloat(row.querySelector('.charge-quantity').value) || 0;
            const unit = row.querySelector('.charge-unit').value.trim() || 'each';
            const rate = parseFloat(row.querySelector('.charge-rate').value) || 0;
            const amount = parseFloat(row.querySelector('.charge-amount').value) || 0;
            
            marginalCharges.push({
                type: 'marginal',
                description,
                quantity,
                unit,
                rate,
                amount
            });
        });
        
        if (hasEmptyMarginalDescription) {
            window.showError('Please enter description for all marginal charges');
            window.hideLoading();
            return;
        }
        
        // Combine all charges
        const allCharges = [...requiredCharges, ...marginalCharges];
        
        if (allCharges.length === 0) {
            window.showError('Please add at least one charge');
            window.hideLoading();
            return;
        }
        
        // Collect advance payment
        const advanceAmount = parseFloat(document.getElementById('advanceAmount').value) || 0;
        let advancePayment = null;
        
        if (advanceAmount > 0) {
            advancePayment = {
                amount: advanceAmount,
                date: document.getElementById('paymentDate').value,
                method: document.getElementById('paymentMethod').value,
                reference: document.getElementById('paymentReference').value || null
            };
        }
        
        // Calculate totals
        const requiredSubtotal = requiredCharges.reduce((sum, charge) => sum + charge.amount, 0);
        const marginalSubtotal = marginalCharges.reduce((sum, charge) => sum + charge.amount, 0);
        const totalCharges = requiredSubtotal + marginalSubtotal;
        const taxRate = 0; // 0% tax for now
        const taxAmount = totalCharges * taxRate;
        
        // Get user data
        const userData = sessionStorage.getItem('pos_user');
        const user = userData ? JSON.parse(userData) : { id: 'system' };
        
        // Prepare invoice data
        const invoiceData = {
            jobCardId: window.wizardData.jobData.id,
            invoiceNumber: window.wizardData.jobData.invoice_no, // Use existing invoice number
            date: new Date().toISOString().split('T')[0],
            dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            notes: document.getElementById('invoiceNotes').value.trim(),
            charges: allCharges, // Now includes both required and marginal
            requiredChargesSubtotal: requiredSubtotal,
            marginalChargesSubtotal: marginalSubtotal,
            subtotal: totalCharges,
            tax: taxAmount,
            total: totalCharges + taxAmount,
            advancePayment: advancePayment,
            createdBy: user.id || 'system'
        };
        
        console.log('Sending invoice data:', invoiceData);
        
        // Use Utils.getApiBaseUrl() to get the correct backend URL
        const apiBaseUrl = window.CONFIG?.API_BASE_URL || 'http://localhost:5000';
        console.log('Saving invoice to:', apiBaseUrl);
        
        const response = await fetch(`${apiBaseUrl}/api/invoices/creation`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionStorage.getItem('token') || ''}`
            },
            body: JSON.stringify(invoiceData)
        });
        
        const result = await response.json();
        
        window.hideLoading();
        
        if (result.success) {
            window.showSuccess('Invoice saved successfully!');
            
            if (generatePDF) {
                // Generate PDF if requested
                window.generatePDF(result.invoiceId);
            }
            
            // Redirect after 2 seconds
            setTimeout(() => {
                window.history.back();
            }, 2000);
        } else {
            window.showError(result.message || 'Failed to save invoice');
        }
        
    } catch (error) {
        window.hideLoading();
        console.error('Save invoice error:', error);
        window.showError('Failed to save invoice: ' + error.message);
    }
};

// PDF generation function
window.generatePDF = function(invoiceId) {
    try {
        const apiBaseUrl = window.CONFIG?.API_BASE_URL || 'http://localhost:5000';
        window.open(`${apiBaseUrl}/api/invoices/${invoiceId}/pdf`, '_blank');
    } catch (error) {
        console.error('PDF generation error:', error);
        window.showError('Failed to generate PDF: ' + error.message);
    }
};

// PDF generation function
window.generatePDF = function(invoiceId) {
    try {
        const apiBaseUrl = window.CONFIG?.API_BASE_URL || 'http://localhost:5000';
        window.open(`${apiBaseUrl}/api/invoices/${invoiceId}/pdf`, '_blank');
    } catch (error) {
        console.error('PDF generation error:', error);
        window.showError('Failed to generate PDF: ' + error.message);
    }
};