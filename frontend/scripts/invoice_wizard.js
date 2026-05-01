// Import SidebarManager from sidebar.js
import { SidebarManager } from './sidebar.js';

// Wizard JavaScript - attach to window object
window.wizardData = {
    jobData: null,
    jobCardId: null,
    invoiceId: null,
    chargeTypes: [],
    requiredChargeCounter: 1,
    marginalChargeCounter: 1,
    requiredCharges: [],
    marginalCharges: []
};

// API base URL
const API_BASE_URL = window.CONFIG?.API_BASE_URL || 'http://localhost:5000';

// Load user data for sidebar
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

// Load charge types from API
async function loadChargeTypes() {
    try {
        console.log('Fetching charge types from:', API_BASE_URL);
        
        const response = await fetch(`${API_BASE_URL}/api/charges/types`, {
            headers: {
                'Authorization': `Bearer ${sessionStorage.getItem('token') || ''}`
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (result.success) {
            console.log('Loaded charge types:', result.data);
            window.wizardData.chargeTypes = result.data;
        } else {
            console.warn('Failed to load charge types:', result.message);
            // Fallback to default charges if API fails
            setDefaultChargeTypes();
        }
    } catch (error) {
        console.error('Failed to load charge types:', error);
        setDefaultChargeTypes();
    }
}

// Set default charge types as fallback
function setDefaultChargeTypes() {
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

// Load job card details from API
async function loadJobCardDetails() {
    const urlParams = new URLSearchParams(window.location.search);
    const jobId = urlParams.get('jobId');
    
    if (!jobId) {
        window.showError('No job card specified');
        return false;
    }
    
    window.wizardData.jobCardId = jobId;
    
    try {
        window.showLoading('Loading job card details...');
        
        const response = await fetch(`${API_BASE_URL}/api/jobcards/${jobId}/details`, {
            headers: {
                'Authorization': `Bearer ${sessionStorage.getItem('token') || ''}`
            }
        });
        
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message);
        }
        
        window.wizardData.jobData = result.data;
        
        // Store invoice ID if exists
        if (result.data.invoice) {
            window.wizardData.invoiceId = result.data.invoice.id;
        }
        
        // Initialize job info display
        window.initializeJobInfo();
        
        // Load existing charges if any
        if (result.data.charges && result.data.charges.length > 0) {
            loadExistingCharges(result.data.charges);
        }
        
        // Load advance payments if any
        if (result.data.advance_payments && result.data.advance_payments.length > 0) {
            loadExistingAdvancePayments(result.data.advance_payments);
        }
        
        window.hideLoading();
        return true;
        
    } catch (error) {
        console.error('Error loading job card:', error);
        window.showError('Failed to load job card details: ' + error.message);
        window.hideLoading();
        return false;
    }
}

// Load existing charges into the wizard
function loadExistingCharges(charges) {
    // Clear existing rows
    document.getElementById('requiredChargesTableBody').innerHTML = '';
    document.getElementById('marginalChargesTableBody').innerHTML = '';
    
    let requiredCount = 0;
    let marginalCount = 0;
    
    charges.forEach(charge => {
        if (charge.charge_type === 'required') {
            addChargeRowFromData('required', charge);
            requiredCount++;
        } else {
            addChargeRowFromData('marginal', charge);
            marginalCount++;
        }
    });
    
    // If no charges, add empty rows
    if (requiredCount === 0) {
        window.addChargeRow('required');
    }
    if (marginalCount === 0) {
        window.addChargeRow('marginal');
    }
    
    // Update totals
    window.updateTotals();
}

// Add charge row from existing data
function addChargeRowFromData(type, chargeData) {
    const tableBodyId = type === 'required' ? 'requiredChargesTableBody' : 'marginalChargesTableBody';
    const tableBody = document.getElementById(tableBodyId);
    const template = document.getElementById('chargeRowTemplate').innerHTML;
    
    const chargeOptions = generateChargeOptions(chargeData.description);
    
    let rowHtml = template
        .replace(/{{chargeTypes}}/g, chargeOptions)
        .replace(/{{id}}/g, `${type}-${Date.now()}-${Math.random()}`);
    
    tableBody.insertAdjacentHTML('beforeend', rowHtml);
    
    const newRow = tableBody.lastElementChild;
    
    // Set values
    const descriptionSelect = newRow.querySelector('.charge-description');
    const customInput = newRow.querySelector('.custom-description');
    const quantityInput = newRow.querySelector('.charge-quantity');
    const unitSelect = newRow.querySelector('.charge-unit');
    const customUnit = newRow.querySelector('.custom-unit');
    const rateInput = newRow.querySelector('.charge-rate');
    const amountInput = newRow.querySelector('.charge-amount');
    
    // Check if description is custom
    const isCustomCharge = !window.wizardData.chargeTypes.some(ct => ct.name === chargeData.description);
    
    if (isCustomCharge) {
        descriptionSelect.value = 'custom';
        customInput.style.display = 'block';
        customInput.value = chargeData.description;
    } else {
        descriptionSelect.value = chargeData.description;
        customInput.style.display = 'none';
    }
    
    quantityInput.value = chargeData.quantity;
    unitSelect.value = chargeData.unit;
    rateInput.value = chargeData.rate;
    amountInput.value = chargeData.amount.toFixed(3);
    
    // Setup event listeners
    window.setupChargeRowEvents(newRow, type);
}

// Generate charge options HTML
function generateChargeOptions(selectedValue = '') {
    let options = '<option value="">Select charge type</option>';
    
    window.wizardData.chargeTypes.forEach(charge => {
        const selected = charge.name === selectedValue ? 'selected' : '';
        options += `<option value="${charge.name}" ${selected}>${charge.name}</option>`;
    });
    
    options += '<option value="custom">Custom...</option>';
    
    return options;
}

// Load existing advance payments
function loadExistingAdvancePayments(payments) {
    if (payments.length > 0) {
        const totalAdvance = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
        document.getElementById('advanceAmount').value = totalAdvance.toFixed(3);
        
        // Set latest payment details
        const latestPayment = payments[0];
        if (latestPayment.payment_date) {
            document.getElementById('paymentDate').value = latestPayment.payment_date;
        }
        if (latestPayment.payment_method) {
            document.getElementById('paymentMethod').value = latestPayment.payment_method;
        }
        if (latestPayment.reference_number) {
            document.getElementById('paymentReference').value = latestPayment.reference_number;
        }
    }
}

// Initialize job info display
window.initializeJobInfo = function() {
    if (!window.wizardData.jobData) return;
    
    const jobData = window.wizardData.jobData;
    
    // Determine shipment type and get appropriate document number
    let documentType = 'Waybill';
    let documentNumber = jobData.truck_waybill_no || 'N/A';
    
    if (jobData.job_no && jobData.job_no.includes('SEA')) {
        documentType = 'HBL Number';
        documentNumber = jobData.hbl || jobData.mbl || 'N/A';
    } else if (jobData.job_no && jobData.job_no.includes('AIR')) {
        documentType = 'HAWB Number';
        documentNumber = jobData.habw || jobData.mabw || 'N/A';
    }
    
    const subtitle = document.getElementById('jobInfoSubtitle');
    subtitle.textContent = `Manage charges and advance payment for ${jobData.job_no || 'Job Card'}`;
    
    const infoGrid = document.getElementById('jobInfoGrid');
    infoGrid.innerHTML = ''; // Clear existing
    
    const infoCards = [
        {
            label: 'Job Number',
            value: jobData.job_no || 'N/A',
            icon: 'fa-hashtag'
        },
        {
            label: 'Invoice Number',
            value: jobData.invoice_no || 'Not Assigned',
            icon: 'fa-file-invoice'
        },
        {
            label: 'Customer',
            value: jobData.customer_name || 'N/A',
            icon: 'fa-user-tie'
        },
        {
            label: 'Route',
            value: `${jobData.departure_location || 'N/A'} → ${jobData.arrival_location || 'N/A'}`,
            icon: 'fa-route'
        },
        {
            label: 'Shipper',
            value: jobData.shipper_name || 'N/A',
            icon: 'fa-truck-loading'
        },
        {
            label: documentType,
            value: documentNumber,
            icon: 'fa-file-contract'
        },
        {
            label: 'Status',
            value: getStatusDisplay(jobData.status),
            icon: 'fa-circle-info',
            badge: true
        }
    ];
    
    infoCards.forEach(card => {
        const cardHtml = `
            <div class="info-card">
                <div class="info-label">
                    <i class="fa-solid ${card.icon}"></i> ${card.label}
                </div>
                <div class="info-value">${escapeHtml(card.value)}</div>
            </div>
        `;
        infoGrid.insertAdjacentHTML('beforeend', cardHtml);
    });
};

// Get status display text
function getStatusDisplay(status) {
    const statusMap = {
        'draft': 'Draft',
        'submitted': 'Submitted / Arrived',
        'approved': 'In Transit',
        'completed': 'Completed',
        'cancelled': 'Cancelled'
    };
    return statusMap[status] || status || 'Unknown';
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Setup charge row events
window.setupChargeRowEvents = function(row, type) {
    // Description change
    const descriptionSelect = row.querySelector('.charge-description');
    const customInput = row.querySelector('.custom-description');
    
    if (descriptionSelect) {
        descriptionSelect.addEventListener('change', function() {
            if (this.value === 'custom') {
                customInput.style.display = 'block';
                customInput.focus();
            } else {
                customInput.style.display = 'none';
                customInput.value = '';
            }
        });
    }
    
    // Custom description input
    if (customInput) {
        customInput.addEventListener('input', function() {
            if (this.value) {
                descriptionSelect.value = 'custom';
            }
        });
    }
    
    // Unit selection
    const unitSelect = row.querySelector('.charge-unit');
    const customUnit = row.querySelector('.custom-unit');
    
    if (unitSelect) {
        unitSelect.addEventListener('change', function() {
            if (this.value === 'custom') {
                customUnit.style.display = 'block';
                customUnit.focus();
            } else {
                customUnit.style.display = 'none';
                customUnit.value = '';
            }
        });
    }
    
    // Quantity and rate inputs
    const quantityInput = row.querySelector('.charge-quantity');
    const rateInput = row.querySelector('.charge-rate');
    
    const calculateRowAmount = () => {
        const quantity = parseFloat(quantityInput?.value) || 0;
        const rate = parseFloat(rateInput?.value) || 0;
        const amount = quantity * rate;
        const amountInput = row.querySelector('.charge-amount');
        if (amountInput) {
            amountInput.value = amount.toFixed(3);
        }
        window.updateTotals();
    };
    
    if (quantityInput) quantityInput.addEventListener('input', calculateRowAmount);
    if (rateInput) rateInput.addEventListener('input', calculateRowAmount);
    
    // Remove button
    const removeBtn = row.querySelector('.remove-charge-btn');
    if (removeBtn) {
        removeBtn.addEventListener('click', function() {
            row.remove();
            window.updateTotals();
        });
    }
};

// Add charge row
window.addChargeRow = function(type) {
    const tableBodyId = type === 'required' ? 'requiredChargesTableBody' : 'marginalChargesTableBody';
    const tableBody = document.getElementById(tableBodyId);
    const template = document.getElementById('chargeRowTemplate').innerHTML;
    
    const chargeOptions = generateChargeOptions();
    
    let rowHtml = template
        .replace(/{{chargeTypes}}/g, chargeOptions)
        .replace(/{{id}}/g, `${type}-${Date.now()}-${Math.random()}`);
    
    tableBody.insertAdjacentHTML('beforeend', rowHtml);
    
    const newRow = tableBody.lastElementChild;
    window.setupChargeRowEvents(newRow, type);
    window.updateTotals();
};

// Update all totals
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
    const advanceAmount = parseFloat(document.getElementById('advanceAmount')?.value) || 0;
    
    // Calculate tax (0% for now)
    const taxRate = 0;
    const taxAmount = totalCharges * taxRate;
    
    // Calculate balance due
    const balanceDue = totalCharges - advanceAmount;
    
    // Update subtotal display
    const requiredSubtotalElem = document.getElementById('requiredSubtotal');
    const marginalSubtotalElem = document.getElementById('marginalSubtotal');
    const totalChargesSumElem = document.getElementById('totalChargesSum');
    const totalChargesElem = document.getElementById('totalCharges');
    const totalAdvanceElem = document.getElementById('totalAdvance');
    const totalTaxElem = document.getElementById('totalTax');
    const balanceDueElem = document.getElementById('balanceDue');
    
    if (requiredSubtotalElem) requiredSubtotalElem.textContent = requiredSubtotal.toFixed(3) + ' KWD';
    if (marginalSubtotalElem) marginalSubtotalElem.textContent = marginalSubtotal.toFixed(3) + ' KWD';
    if (totalChargesSumElem) totalChargesSumElem.textContent = totalCharges.toFixed(3) + ' KWD';
    if (totalChargesElem) totalChargesElem.textContent = totalCharges.toFixed(3);
    if (totalAdvanceElem) totalAdvanceElem.textContent = advanceAmount.toFixed(3);
    if (totalTaxElem) totalTaxElem.textContent = taxAmount.toFixed(3);
    if (balanceDueElem) balanceDueElem.textContent = balanceDue.toFixed(3);
};

// Save invoice
window.saveInvoice = async function(generatePDF = false) {
    try {
        window.showLoading(generatePDF ? 'Saving invoice and generating PDF...' : 'Saving invoice...');
        
        if (!window.wizardData.jobData) {
            window.showError('Job data not found');
            window.hideLoading();
            return;
        }
        
        // Collect required charges
        const requiredCharges = [];
        let hasError = false;
        
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
                window.showError('Please enter description for all required charges');
                hasError = true;
                return;
            }
            
            const quantity = parseFloat(row.querySelector('.charge-quantity').value) || 0;
            const unit = row.querySelector('.charge-unit').value;
            const customUnitInput = row.querySelector('.custom-unit');
            let unitValue = unit;
            
            if (unit === 'custom' && customUnitInput) {
                unitValue = customUnitInput.value.trim() || 'each';
            }
            
            const rate = parseFloat(row.querySelector('.charge-rate').value) || 0;
            const amount = parseFloat(row.querySelector('.charge-amount').value) || 0;
            
            if (quantity <= 0) {
                window.showError('Quantity must be greater than 0 for required charges');
                hasError = true;
                return;
            }
            
            requiredCharges.push({
                description,
                quantity,
                unit: unitValue,
                rate,
                amount,
                charge_type: 'required'
            });
        });
        
        if (hasError) {
            window.hideLoading();
            return;
        }
        
        // Collect marginal charges
        const marginalCharges = [];
        
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
                window.showError('Please enter description for all marginal charges');
                hasError = true;
                return;
            }
            
            const quantity = parseFloat(row.querySelector('.charge-quantity').value) || 0;
            const unit = row.querySelector('.charge-unit').value;
            const customUnitInput = row.querySelector('.custom-unit');
            let unitValue = unit;
            
            if (unit === 'custom' && customUnitInput) {
                unitValue = customUnitInput.value.trim() || 'each';
            }
            
            const rate = parseFloat(row.querySelector('.charge-rate').value) || 0;
            const amount = parseFloat(row.querySelector('.charge-amount').value) || 0;
            
            marginalCharges.push({
                description,
                quantity,
                unit: unitValue,
                rate,
                amount,
                charge_type: 'marginal'
            });
        });
        
        if (hasError) {
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
        const advanceAmount = parseFloat(document.getElementById('advanceAmount')?.value) || 0;
        let advancePayment = null;
        
        if (advanceAmount > 0) {
            advancePayment = {
                amount: advanceAmount,
                date: document.getElementById('paymentDate')?.value || new Date().toISOString().split('T')[0],
                method: document.getElementById('paymentMethod')?.value || 'cash',
                reference: document.getElementById('paymentReference')?.value || null,
                notes: null
            };
        }
        
        // Calculate totals
        const requiredSubtotal = requiredCharges.reduce((sum, charge) => sum + charge.amount, 0);
        const marginalSubtotal = marginalCharges.reduce((sum, charge) => sum + charge.amount, 0);
        const totalChargesSum = requiredSubtotal + marginalSubtotal;
        
        // Get user data
        const userData = sessionStorage.getItem('pos_user');
        const user = userData ? JSON.parse(userData) : { id: 'system', name: 'System' };
        
        // Prepare invoice data
        const invoiceData = {
            jobCardId: window.wizardData.jobData.id,
            invoiceNumber: window.wizardData.jobData.invoice_no,
            date: new Date().toISOString().split('T')[0],
            dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            notes: document.getElementById('invoiceNotes')?.value.trim() || '',
            charges: allCharges,
            subtotal: totalChargesSum,
            tax: 0,
            total: totalChargesSum,
            advancePayment: advancePayment,
            createdBy: user.id || 'system'
        };
        
        console.log('Sending invoice data:', invoiceData);
        
        const response = await fetch(`${API_BASE_URL}/api/invoices/creation`, {
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
            
            // Update job card status to 'submitted' (Arrived) when charges are saved
            await updateJobCardStatus('arrived');
            
            if (generatePDF && result.invoiceNumber) {
                // Generate PDF
                window.open(`${API_BASE_URL}/api/invoices/${result.invoiceId}/pdf`, '_blank');
            }
            
            // Redirect after 2 seconds
            setTimeout(() => {
                window.location.href = 'index.html';
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

// Update job card status
async function updateJobCardStatus(status) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/jobcards/${window.wizardData.jobCardId}/update-status`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionStorage.getItem('token') || ''}`
            },
            body: JSON.stringify({
                status: status,
                notes: 'Charges added via Charges Wizard'
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            console.log('Job card status updated to:', status);
        } else {
            console.warn('Failed to update job status:', result.message);
        }
    } catch (error) {
        console.error('Error updating job status:', error);
    }
}

// UI helper functions
window.showLoading = function(message = 'Processing...') {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    if (loadingText) loadingText.textContent = message;
    if (loadingOverlay) loadingOverlay.classList.add('active');
};

window.hideLoading = function() {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('active');
};

window.showSuccess = function(message = 'Operation completed successfully!') {
    const successMsg = document.getElementById('successMessage');
    if (successMsg) {
        const span = successMsg.querySelector('span');
        if (span) span.textContent = message;
        successMsg.classList.add('show');
        
        setTimeout(() => {
            successMsg.classList.remove('show');
        }, 3000);
    }
};

window.showError = function(message = 'An error occurred!') {
    const errorMsg = document.getElementById('errorMessage');
    if (errorMsg) {
        const span = errorMsg.querySelector('span');
        if (span) span.textContent = message;
        errorMsg.classList.add('show');
        
        setTimeout(() => {
            errorMsg.classList.remove('show');
        }, 5000);
    }
};

window.cancelWizard = function() {
    if (confirm('Are you sure you want to cancel? Any unsaved changes will be lost.')) {
        window.location.href = 'index.html';
    }
};

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', async function() {
    // Initialize Sidebar
    window.sidebarManager = new SidebarManager();
    
    // Load user data for sidebar
    window.loadUserData();
    
    // Load charge types from backend
    await loadChargeTypes();
    
    // Load job card details from API (using jobId parameter)
    const loaded = await loadJobCardDetails();
    
    if (loaded) {
        // Add event listeners
        const addRequiredBtn = document.getElementById('addRequiredChargeBtn');
        const addMarginalBtn = document.getElementById('addMarginalChargeBtn');
        const advanceAmount = document.getElementById('advanceAmount');
        const cancelBtn = document.getElementById('cancelBtn');
        const saveBtn = document.getElementById('saveBtn');
        const saveAndGenerateBtn = document.getElementById('saveAndGenerateBtn');
        
        if (addRequiredBtn) addRequiredBtn.addEventListener('click', () => window.addChargeRow('required'));
        if (addMarginalBtn) addMarginalBtn.addEventListener('click', () => window.addChargeRow('marginal'));
        if (advanceAmount) advanceAmount.addEventListener('input', window.updateTotals);
        if (cancelBtn) cancelBtn.addEventListener('click', window.cancelWizard);
        if (saveBtn) saveBtn.addEventListener('click', () => window.saveInvoice(false));
        if (saveAndGenerateBtn) saveAndGenerateBtn.addEventListener('click', () => window.saveInvoice(true));
        
        // Set today's date as default payment date
        const paymentDate = document.getElementById('paymentDate');
        if (paymentDate) {
            paymentDate.value = new Date().toISOString().split('T')[0];
        }
        
        // Add initial empty rows if no charges exist
        const requiredRows = document.querySelectorAll('#requiredChargesTableBody tr').length;
        const marginalRows = document.querySelectorAll('#marginalChargesTableBody tr').length;
        
        if (requiredRows === 0) {
            window.addChargeRow('required');
        }
        if (marginalRows === 0) {
            window.addChargeRow('marginal');
        }
        
        // Set page title
        if (window.wizardData.jobData && window.wizardData.jobData.job_no) {
            document.title = `Charges Wizard - ${window.wizardData.jobData.job_no}`;
        }
    }
});