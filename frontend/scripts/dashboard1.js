import { SidebarManager } from './sidebar.js';

// Dashboard Application
class DashboardApp {
    constructor() {
        this.API_BASE_URL = 'https://powerpoint-fruit-valves-succeed.trycloudflare.com/api';
        this.jobCards = [];
        this.currentJobCard = null;
        this.currentFilter = 'bayan';
        this.currentView = 'board';
        
        // DOM Elements
        this.elements = {
            // Search and Filter
            globalSearch: document.getElementById('globalSearch'),
            clearSearch: document.getElementById('clearSearch'),
            searchBtn: document.getElementById('searchBtn'),
            filterOptions: document.querySelectorAll('input[name="filterType"]'),
            suggestionsDropdown: document.getElementById('suggestionsDropdown'),
            
            // Views
            boardView: document.getElementById('boardView'),
            tableView: document.getElementById('tableView'),
            viewBtns: document.querySelectorAll('.view-btn'),
            
            // Columns
            colTransit: document.getElementById('colTransit'),
            colArrived: document.getElementById('colArrived'),
            colCompleted: document.getElementById('colCompleted'),
            
            // Counts
            transitCount: document.getElementById('transitCount'),
            arrivedCount: document.getElementById('arrivedCount'),
            completedCount: document.getElementById('completedCount'),
            
            // Stats
            statTransit: document.getElementById('statTransit'),
            statArrived: document.getElementById('statArrived'),
            statCompleted: document.getElementById('statCompleted'),
            statRevenue: document.getElementById('statRevenue'),
            
            // Table
            jobCardsTableBody: document.getElementById('jobCardsTableBody'),
            refreshTable: document.getElementById('refreshTable'),
            
            // Modals
            jobCardModal: document.getElementById('jobCardModal'),
            invoiceModal: document.getElementById('invoiceModal'),
            createJobCardModal: document.getElementById('createJobCardModal'),
            
            // Buttons
            createJobCardBtn: document.getElementById('createJobCardBtn'),
            filterToggle: document.getElementById('filterToggle'),
            closeJobCardModal: document.getElementById('closeJobCardModal'),
            closeInvoiceModal: document.getElementById('closeInvoiceModal'),
            closeCreateJobCardModal: document.getElementById('closeCreateJobCardModal'),
            editJobCardBtn: document.getElementById('editJobCardBtn'),
            createInvoiceBtn: document.getElementById('createInvoiceBtn'),
            
            // Loading
            loadingOverlay: document.getElementById('loadingOverlay')
        };
        
        // Templates
        this.templates = {
            jobCard: document.getElementById('jobCardTemplate'),
            tableRow: document.getElementById('tableRowTemplate')
        };
        
        this.init();
    }

    async init() {
        // Initialize sidebar
        this.sidebarManager = new SidebarManager();
        
        // Set up event listeners
        this.setupEventListeners();
        
        // Load initial data
        await this.loadInitialData();
        
        // Update stats
        this.updateStats();
    }

    setupEventListeners() {
        // Search functionality
        if (this.elements.globalSearch) {
            this.elements.globalSearch.addEventListener('input', (e) => this.handleSearchInput(e));
            this.elements.globalSearch.addEventListener('focus', () => this.showSuggestions());
        }

        if (this.elements.clearSearch) {
            this.elements.clearSearch.addEventListener('click', () => this.clearSearch());
        }

        if (this.elements.searchBtn) {
            this.elements.searchBtn.addEventListener('click', () => this.performSearch());
        }

        // Filter options
        this.elements.filterOptions.forEach(option => {
            option.addEventListener('change', (e) => {
                this.currentFilter = e.target.value;
                this.performSearch();
            });
        });

        // View toggle
        this.elements.viewBtns.forEach(btn => {
            btn.addEventListener('click', (e) => this.switchView(e.target.dataset.view));
        });

        // Modal controls
        if (this.elements.closeJobCardModal) {
            this.elements.closeJobCardModal.addEventListener('click', () => this.closeModal('jobCardModal'));
        }

        if (this.elements.closeInvoiceModal) {
            this.elements.closeInvoiceModal.addEventListener('click', () => this.closeModal('invoiceModal'));
        }

        if (this.elements.closeCreateJobCardModal) {
            this.elements.closeCreateJobCardModal.addEventListener('click', () => this.closeModal('createJobCardModal'));
        }

        // Create buttons
        if (this.elements.createJobCardBtn) {
            this.elements.createJobCardBtn.addEventListener('click', () => this.showCreateJobCardModal());
        }

        if (this.elements.editJobCardBtn) {
            this.elements.editJobCardBtn.addEventListener('click', () => this.editJobCard());
        }

        if (this.elements.createInvoiceBtn) {
            this.elements.createInvoiceBtn.addEventListener('click', () => this.showInvoiceModal());
        }

        // Table refresh
        if (this.elements.refreshTable) {
            this.elements.refreshTable.addEventListener('click', () => this.refreshData());
        }

        // Close modals on outside click
        document.addEventListener('click', (e) => {
            const modals = ['jobCardModal', 'invoiceModal', 'createJobCardModal'];
            modals.forEach(modalId => {
                const modal = document.getElementById(modalId);
                if (modal && e.target === modal) {
                    this.closeModal(modalId);
                }
            });
        });

        // Close modals with Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const activeModals = document.querySelectorAll('.modal.active');
                if (activeModals.length > 0) {
                    this.closeModal(activeModals[0].id);
                }
            }
        });
    }

    async loadInitialData() {
        this.showLoading();
        
        try {
            // Load job cards
            const jobCardsResponse = await fetch(`${this.API_BASE_URL}/jobcards/search?limit=100`);
            if (jobCardsResponse.ok) {
                const jobCardsData = await jobCardsResponse.json();
                if (jobCardsData.success) {
                    this.jobCards = jobCardsData.data;
                    this.renderJobCards();
                    this.renderJobCardsTable();
                    this.updateColumnCounts();
                }
            }
            
            // Load dashboard stats
            await this.loadDashboardStats();
            
        } catch (error) {
            console.error('Error loading initial data:', error);
            this.showError('Failed to load data. Please check your connection.');
        } finally {
            this.hideLoading();
        }
    }

    async loadDashboardStats() {
        try {
            // Load job card stats
            const statsResponse = await fetch(`${this.API_BASE_URL}/stats/jobcards`);
            if (statsResponse.ok) {
                const statsData = await statsResponse.json();
                if (statsData.success) {
                    this.updateStatsDisplay(statsData);
                }
            }
        } catch (error) {
            console.error('Error loading stats:', error);
        }
    }

    updateStatsDisplay(stats) {
        if (this.elements.statTransit) {
            this.elements.statTransit.textContent = stats.submittedJobCards || 0;
        }
        if (this.elements.statArrived) {
            this.elements.statArrived.textContent = stats.draftJobCards || 0;
        }
        if (this.elements.statCompleted) {
            this.elements.statCompleted.textContent = stats.totalJobCards || 0;
        }
        if (this.elements.statRevenue) {
            this.elements.statRevenue.textContent = stats.totalInvoices || 0;
        }
    }

    renderJobCards() {
        // Clear columns
        [this.elements.colTransit, this.elements.colArrived, this.elements.colCompleted].forEach(col => {
            if (col) col.innerHTML = '';
        });

        // Render each job card
        this.jobCards.forEach(jobCard => {
            const status = this.getJobCardStatus(jobCard);
            const column = this.getColumnByStatus(status);
            
            if (column) {
                const cardElement = this.createJobCardElement(jobCard);
                column.appendChild(cardElement);
            }
        });

        // Add event listeners to job card buttons
        this.addJobCardEventListeners();
    }

    getJobCardStatus(jobCard) {
        const status = jobCard.status?.toLowerCase() || 'draft';
        
        if (status.includes('completed') || status.includes('paid')) {
            return 'completed';
        } else if (status.includes('submitted') || status.includes('arrived')) {
            return 'arrived';
        } else {
            return 'transit';
        }
    }

    getColumnByStatus(status) {
        switch(status) {
            case 'transit': return this.elements.colTransit;
            case 'arrived': return this.elements.colArrived;
            case 'completed': return this.elements.colCompleted;
            default: return this.elements.colTransit;
        }
    }

    createJobCardElement(jobCard) {
    const template = this.templates.jobCard.content.cloneNode(true);
    const card = template.querySelector('.job-card');
    
    // Debug: Check what elements exist
    console.log('Template elements:', card.innerHTML);
    
    // Set data attributes
    card.dataset.id = jobCard.id;
    card.dataset.status = jobCard.status;
    
    // Fill in data - use the actual structure from your HTML template
    const status = this.getJobCardStatus(jobCard);
    const statusClass = this.getStatusClass(status);
    const statusDisplay = this.getStatusDisplay(status);
    
    // Get elements by their structure in the template
    // Assuming your template has this structure:
    
    // Method 1: Direct textContent for spans
    const jobNumberEl = card.querySelector('.job-number');
    if (jobNumberEl) {
        jobNumberEl.textContent = jobCard.job_no || 'N/A';
    } else {
        // Fallback: find element containing job number
        const jobNumberDiv = card.querySelector('.card-header .job-number');
        if (jobNumberDiv) jobNumberDiv.textContent = jobCard.job_no || 'N/A';
    }
    
    // Update job status
    const jobStatusEl = card.querySelector('.job-status');
    if (jobStatusEl) {
        jobStatusEl.textContent = statusDisplay;
        jobStatusEl.className = `job-status ${statusClass}`;
    } else {
        // Find status element
        const statusDiv = card.querySelector('.card-header .job-status');
        if (statusDiv) {
            statusDiv.textContent = statusDisplay;
            statusDiv.className = `job-status ${statusClass}`;
        }
    }
    
    // Update route info (port_arrival)
    const routeSpan = card.querySelector('.route-info span');
    if (routeSpan) {
        routeSpan.textContent = `Kuwait → ${jobCard.port_arrival || 'N/A'}`;
    }
    
    // Update customer info
    const customerSpan = card.querySelector('.customer-info span');
    if (customerSpan) {
        customerSpan.textContent = jobCard.customer_name || 'N/A';
    }
    
    // Update shipper info
    const shipperSpan = card.querySelector('.shipper-info span');
    if (shipperSpan) {
        shipperSpan.textContent = jobCard.shipper_name || 'N/A';
    }
    
    // Update invoice info
    const invoiceSpan = card.querySelector('.meta-item:first-child span');
    if (invoiceSpan) {
        invoiceSpan.textContent = jobCard.invoice_no || 'N/A';
    }
    
    // Update weight info
    const weightSpan = card.querySelector('.meta-item:last-child span');
    if (weightSpan) {
        weightSpan.textContent = `${jobCard.gross_weight || '0'} kg`;
    }
    
    // Update total amount
    const totalAmountDiv = card.querySelector('.total-amount');
    if (totalAmountDiv) {
        totalAmountDiv.textContent = jobCard.invoice_total ? 
            `${parseFloat(jobCard.invoice_total).toFixed(3)} KWD` : '0.000 KWD';
    }
    
    return card;
}

    getStatusClass(status) {
        switch(status) {
            case 'completed': return 'completed';
            case 'arrived': return 'submitted';
            case 'transit': return 'draft';
            default: return 'draft';
        }
    }

    getStatusDisplay(status) {
        switch(status) {
            case 'completed': return 'Completed';
            case 'arrived': return 'Arrived';
            case 'transit': return 'In Transit';
            default: return 'Draft';
        }
    }

    addJobCardEventListeners() {
        // View buttons
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const jobCardId = btn.closest('.job-card').dataset.id;
                this.showJobCardDetails(jobCardId);
            });
        });

        // Edit buttons
        document.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const jobCardId = btn.closest('.job-card').dataset.id;
                this.editJobCard(jobCardId);
            });
        });

        // Invoice buttons
        document.querySelectorAll('.invoice-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const jobCardId = btn.closest('.job-card').dataset.id;
                this.showInvoiceModal(jobCardId);
            });
        });
    }

    renderJobCardsTable() {
        if (!this.elements.jobCardsTableBody) return;
        
        this.elements.jobCardsTableBody.innerHTML = '';
        
        this.jobCards.forEach(jobCard => {
            const row = this.createTableRow(jobCard);
            this.elements.jobCardsTableBody.appendChild(row);
        });

        // Add event listeners to table row buttons
        this.addTableRowEventListeners();
    }

    createTableRow(jobCard) {
        const template = this.templates.tableRow.content.cloneNode(true);
        const row = template.querySelector('tr');
        
        const status = this.getJobCardStatus(jobCard);
        const statusClass = this.getStatusClass(status);
        const statusDisplay = this.getStatusDisplay(status);
        const createdDate = new Date(jobCard.created_at).toLocaleDateString('en-GB');
        
        row.dataset.id = jobCard.id;
        row.querySelector('.job_no').textContent = jobCard.job_no || 'N/A';
        row.querySelector('.invoice_no').textContent = jobCard.invoice_no || 'N/A';
        row.querySelector('.customer_name').textContent = jobCard.customer_name || 'N/A';
        row.querySelector('.shipper_name').textContent = jobCard.shipper_name || 'N/A';
        row.querySelector('.port_arrival').textContent = jobCard.port_arrival || 'N/A';
        row.querySelector('.status_display').textContent = statusDisplay;
        row.querySelector('.status_badge').className = `status-badge ${statusClass}`;
        row.querySelector('.created_date').textContent = createdDate;
        
        return row;
    }

    addTableRowEventListeners() {
        document.querySelectorAll('.table-actions .view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const jobCardId = btn.closest('tr').dataset.id;
                this.showJobCardDetails(jobCardId);
            });
        });

        document.querySelectorAll('.table-actions .edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const jobCardId = btn.closest('tr').dataset.id;
                this.editJobCard(jobCardId);
            });
        });

        document.querySelectorAll('.table-actions .invoice-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const jobCardId = btn.closest('tr').dataset.id;
                this.showInvoiceModal(jobCardId);
            });
        });
    }

    updateColumnCounts() {
        const counts = {
            transit: 0,
            arrived: 0,
            completed: 0
        };

        this.jobCards.forEach(jobCard => {
            const status = this.getJobCardStatus(jobCard);
            counts[status] = (counts[status] || 0) + 1;
        });

        if (this.elements.transitCount) {
            this.elements.transitCount.textContent = counts.transit;
        }
        if (this.elements.arrivedCount) {
            this.elements.arrivedCount.textContent = counts.arrived;
        }
        if (this.elements.completedCount) {
            this.elements.completedCount.textContent = counts.completed;
        }
    }

    async showJobCardDetails(jobCardId) {
        this.showLoading();
        
        try {
            const response = await fetch(`${this.API_BASE_URL}/jobcards/${jobCardId}`);
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    this.currentJobCard = data.data;
                    this.displayJobCardDetails();
                    this.openModal('jobCardModal');
                }
            }
        } catch (error) {
            console.error('Error loading job card details:', error);
            this.showError('Failed to load job card details.');
        } finally {
            this.hideLoading();
        }
    }

    displayJobCardDetails() {
        const container = document.getElementById('jobCardDetailsContent');
        if (!container || !this.currentJobCard) return;

        const jobCard = this.currentJobCard;
        const createdDate = new Date(jobCard.created_at).toLocaleDateString('en-GB');
        const submittedDate = jobCard.submitted_at ? 
            new Date(jobCard.submitted_at).toLocaleDateString('en-GB') : 'Not submitted';
        const bayanDate = jobCard.bayan_date ? 
            new Date(jobCard.bayan_date).toLocaleDateString('en-GB') : 'N/A';

        container.innerHTML = `
            <div class="details-grid">
                <div class="detail-section">
                    <h4>Basic Information</h4>
                    <div class="detail-row">
                        <div class="detail-item">
                            <label>Job Number:</label>
                            <span>${jobCard.job_no}</span>
                        </div>
                        <div class="detail-item">
                            <label>Invoice Number:</label>
                            <span>${jobCard.invoice_no || 'N/A'}</span>
                        </div>
                        <div class="detail-item">
                            <label>Status:</label>
                            <span class="status-badge ${this.getStatusClass(this.getJobCardStatus(jobCard))}">
                                ${jobCard.status || 'Draft'}
                            </span>
                        </div>
                    </div>
                </div>

                <div class="detail-section">
                    <h4>Customer Information</h4>
                    <div class="detail-row">
                        <div class="detail-item">
                            <label>Customer Name:</label>
                            <span>${jobCard.customer_name}</span>
                        </div>
                        <div class="detail-item">
                            <label>Customer Reference:</label>
                            <span>${jobCard.customer_ref_no || 'N/A'}</span>
                        </div>
                        <div class="detail-item">
                            <label>Requester Name:</label>
                            <span>${jobCard.requester_name || 'N/A'}</span>
                        </div>
                    </div>
                    <div class="detail-row">
                        <div class="detail-item">
                            <label>Email:</label>
                            <span>${jobCard.email || 'N/A'}</span>
                        </div>
                        <div class="detail-item">
                            <label>Phone:</label>
                            <span>${jobCard.phone || 'N/A'}</span>
                        </div>
                        <div class="detail-item">
                            <label>Address:</label>
                            <span>${jobCard.customer_address || 'N/A'}</span>
                        </div>
                    </div>
                </div>

                <div class="detail-section">
                    <h4>Shipping Information</h4>
                    <div class="detail-row">
                        <div class="detail-item">
                            <label>Shipper Name:</label>
                            <span>${jobCard.shipper_name}</span>
                        </div>
                        <div class="detail-item">
                            <label>Shipper Reference:</label>
                            <span>${jobCard.shipper_ref_no || 'N/A'}</span>
                        </div>
                        <div class="detail-item">
                            <label>Port Arrival:</label>
                            <span>${jobCard.port_arrival}</span>
                        </div>
                    </div>
                    <div class="detail-row">
                        <div class="detail-item">
                            <label>Bayan Number:</label>
                            <span>${jobCard.bayan_no || 'N/A'}</span>
                        </div>
                        <div class="detail-item">
                            <label>Bayan Date:</label>
                            <span>${bayanDate}</span>
                        </div>
                        <div class="detail-item">
                            <label>Truck Waybill:</label>
                            <span>${jobCard.truck_waybill_no || 'N/A'}</span>
                        </div>
                    </div>
                </div>

                <div class="detail-section">
                    <h4>Cargo Details</h4>
                    <div class="detail-row">
                        <div class="detail-item">
                            <label>Gross Weight:</label>
                            <span>${jobCard.gross_weight || '0'} kg</span>
                        </div>
                        <div class="detail-item">
                            <label>Packages:</label>
                            <span>${jobCard.packages || '0'}</span>
                        </div>
                        <div class="detail-item">
                            <label>Package Type:</label>
                            <span>${jobCard.package_type || 'N/A'}</span>
                        </div>
                    </div>
                    <div class="detail-row">
                        <div class="detail-item">
                            <label>Dimensions:</label>
                            <span>${jobCard.dimensions || 'N/A'}</span>
                        </div>
                        <div class="detail-item">
                            <label>Description:</label>
                            <span>${jobCard.description || 'N/A'}</span>
                        </div>
                    </div>
                </div>

                <div class="detail-section">
                    <h4>Timeline</h4>
                    <div class="detail-row">
                        <div class="detail-item">
                            <label>Created Date:</label>
                            <span>${createdDate}</span>
                        </div>
                        <div class="detail-item">
                            <label>Submitted Date:</label>
                            <span>${submittedDate}</span>
                        </div>
                        <div class="detail-item">
                            <label>ETD:</label>
                            <span>${jobCard.estd ? new Date(jobCard.estd).toLocaleDateString('en-GB') : 'N/A'}</span>
                        </div>
                        <div class="detail-item">
                            <label>ETA:</label>
                            <span>${jobCard.eta ? new Date(jobCard.eta).toLocaleDateString('en-GB') : 'N/A'}</span>
                        </div>
                    </div>
                </div>

                ${jobCard.special_instructions ? `
                    <div class="detail-section">
                        <h4>Special Instructions</h4>
                        <div class="detail-row">
                            <div class="detail-item full-width">
                                <p>${jobCard.special_instructions}</p>
                            </div>
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    async editJobCard(jobCardId = null) {
        if (!jobCardId && this.currentJobCard) {
            jobCardId = this.currentJobCard.id;
        }

        if (!jobCardId) return;

        // Close current modal
        this.closeModal('jobCardModal');
        
        // Show loading
        this.showLoading();
        
        try {
            // Load job card data for editing
            const response = await fetch(`${this.API_BASE_URL}/jobcards/${jobCardId}`);
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    // Show edit form (you'll need to implement this)
                    console.log('Edit job card:', data.data);
                    // For now, show an alert
                    alert('Edit functionality will be implemented in the next phase');
                }
            }
        } catch (error) {
            console.error('Error loading job card for editing:', error);
            this.showError('Failed to load job card for editing.');
        } finally {
            this.hideLoading();
        }
    }

    async showInvoiceModal(jobCardId = null) {
        if (!jobCardId && this.currentJobCard) {
            jobCardId = this.currentJobCard.id;
        }

        if (!jobCardId) return;

        this.showLoading();
        
        try {
            // Load job card data
            const response = await fetch(`${this.API_BASE_URL}/jobcards/${jobCardId}`);
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    this.currentJobCard = data.data;
                    this.setupInvoiceForm();
                    this.openModal('invoiceModal');
                }
            }
        } catch (error) {
            console.error('Error loading job card for invoice:', error);
            this.showError('Failed to load job card for invoice creation.');
        } finally {
            this.hideLoading();
        }
    }

    setupInvoiceForm() {
        if (!this.currentJobCard) return;

        // Set basic information
        document.getElementById('jobNo').value = this.currentJobCard.job_no;
        document.getElementById('customerName').value = this.currentJobCard.customer_name;
        document.getElementById('customerRef').value = this.currentJobCard.customer_ref_no || '';
        
        // Set dates
        const today = new Date().toISOString().split('T')[0];
        const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        document.getElementById('invoiceDate').value = today;
        document.getElementById('dueDate').value = dueDate;
        
        // Generate invoice number
        this.generateInvoiceNumber();
        
        // Initialize charges table
        this.initializeChargesTable();
        
        // Update totals
        this.updateInvoiceTotals();
    }

    generateInvoiceNumber() {
        const year = new Date().getFullYear();
        const randomNum = Math.floor(Math.random() * 90000) + 10000;
        const invoiceNumber = `INV/${year}/${randomNum}`;
        document.getElementById('invoiceNo').value = invoiceNumber;
    }

    initializeChargesTable() {
        const tableBody = document.getElementById('chargesTableBody');
        tableBody.innerHTML = '';
        
        // Add default charges
        const defaultCharges = [
            {
                description: "CUSTOMS CLEARANCE SERVICE CHARGE (NUWASIB)",
                qty: 1,
                unitAmount: 30.000,
                amount: 30.000
            },
            {
                description: "INSPECTION CHARGES",
                qty: 1,
                unitAmount: 10.000,
                amount: 10.000
            },
            {
                description: "GLOBAL CLEARINGHOUSE SYSTEMS CHARGES",
                qty: 1,
                unitAmount: 27.210,
                amount: 27.210
            }
        ];
        
        defaultCharges.forEach((charge, index) => {
            this.addChargeRow(charge, index);
        });
    }

    addChargeRow(chargeData = null, index = null) {
        const tableBody = document.getElementById('chargesTableBody');
        const rowIndex = index !== null ? index : tableBody.children.length;
        
        const chargeOptions = [
            "CUSTOMS CLEARANCE SERVICE CHARGE (NUWASIB)",
            "INSPECTION CHARGES",
            "GLOBAL CLEARINGHOUSE SYSTEMS CHARGES",
            "CHAMBER OF COMMERCE LEGALIZATION CHARGES",
            "CHAMBER OF COMMERCE LEGALIZATION SERVICE CHARGES",
            "TRANSPORTATION CHARGES",
            "DOCUMENTATION CHARGES",
            "STORAGE CHARGES",
            "HANDLING CHARGES"
        ];
        
        const options = chargeOptions.map(option => 
            `<option value="${option}" ${chargeData?.description === option ? 'selected' : ''}>${option}</option>`
        ).join('');
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${rowIndex + 1}</td>
            <td>
                <select class="form-control charge-description">
                    ${options}
                </select>
            </td>
            <td>
                <input type="number" class="form-control charge-qty" 
                       value="${chargeData?.qty || 1}" min="1" step="1">
            </td>
            <td>
                <input type="number" class="form-control charge-unit-amount" 
                       value="${chargeData?.unitAmount || 0.000}" min="0" step="0.001">
            </td>
            <td>
                <input type="text" class="form-control charge-amount" 
                       value="${chargeData?.amount || 0.000}" readonly>
            </td>
            <td>
                <button type="button" class="btn btn-sm btn-danger remove-charge">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </td>
        `;
        
        tableBody.appendChild(row);
        
        // Add event listeners
        const qtyInput = row.querySelector('.charge-qty');
        const unitAmountInput = row.querySelector('.charge-unit-amount');
        const removeBtn = row.querySelector('.remove-charge');
        
        qtyInput.addEventListener('input', () => this.updateChargeAmount(row));
        unitAmountInput.addEventListener('input', () => this.updateChargeAmount(row));
        removeBtn.addEventListener('click', () => {
            row.remove();
            this.updateChargeRowNumbers();
            this.updateInvoiceTotals();
        });
        
        // Update amount for this row
        this.updateChargeAmount(row);
    }

    updateChargeAmount(row) {
        const qty = parseFloat(row.querySelector('.charge-qty').value) || 0;
        const unitAmount = parseFloat(row.querySelector('.charge-unit-amount').value) || 0;
        const amount = qty * unitAmount;
        
        row.querySelector('.charge-amount').value = amount.toFixed(3);
        this.updateInvoiceTotals();
    }

    updateChargeRowNumbers() {
        const rows = document.querySelectorAll('#chargesTableBody tr');
        rows.forEach((row, index) => {
            row.cells[0].textContent = index + 1;
        });
    }

    updateInvoiceTotals() {
        let subtotal = 0;
        
        document.querySelectorAll('.charge-amount').forEach(input => {
            subtotal += parseFloat(input.value) || 0;
        });
        
        const tax = parseFloat(document.getElementById('tax').value) || 0;
        const total = subtotal + tax;
        const advance = parseFloat(document.getElementById('advanceAmount').value) || 0;
        const remaining = total - advance;
        
        document.getElementById('subtotal').value = subtotal.toFixed(3);
        document.getElementById('total').value = total.toFixed(3);
        document.getElementById('remainingAmount').value = remaining.toFixed(3);
        
        // Update amount in words
        this.updateAmountInWords(total);
    }

    updateAmountInWords(amount) {
        const words = this.convertNumberToWords(amount);
        document.getElementById('amountWords').value = words;
    }

    convertNumberToWords(num) {
        // Simplified number to words conversion
        const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
        const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
        const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
        
        const whole = Math.floor(num);
        const decimal = Math.round((num - whole) * 1000);
        
        let words = '';
        
        if (whole === 0 && decimal === 0) return 'Zero Dinar only';
        
        if (whole > 0) {
            if (whole >= 1000) {
                const thousands = Math.floor(whole / 1000);
                words += this.convertNumberToWords(thousands) + ' Thousand ';
                whole %= 1000;
            }
            
            if (whole >= 100) {
                words += ones[Math.floor(whole / 100)] + ' Hundred ';
                whole %= 100;
            }
            
            if (whole > 0) {
                if (whole < 10) {
                    words += ones[whole];
                } else if (whole < 20) {
                    words += teens[whole - 10];
                } else {
                    words += tens[Math.floor(whole / 10)];
                    if (whole % 10 > 0) {
                        words += ' ' + ones[whole % 10];
                    }
                }
            }
            
            words += ' Dinar';
            if (whole !== 1) words += 's';
        }
        
        if (decimal > 0) {
            if (words) words += ' and ';
            words += decimal + ' Fils';
        }
        
        return words + ' only';
    }

    async saveInvoice() {
        const formData = {
            jobCardId: this.currentJobCard.id,
            invoiceData: {
                invoiceDate: document.getElementById('invoiceDate').value,
                invoiceNo: document.getElementById('invoiceNo').value,
                notes: document.getElementById('invoiceNotes').value
            },
            charges: [],
            advancePayment: {
                amount: parseFloat(document.getElementById('advanceAmount').value) || 0,
                date: document.getElementById('advanceDate').value,
                method: document.getElementById('paymentMethod').value
            }
        };
        
        // Collect charges
        document.querySelectorAll('#chargesTableBody tr').forEach(row => {
            formData.charges.push({
                description: row.querySelector('.charge-description').value,
                qty: parseFloat(row.querySelector('.charge-qty').value) || 0,
                unitAmount: parseFloat(row.querySelector('.charge-unit-amount').value) || 0,
                amount: parseFloat(row.querySelector('.charge-amount').value) || 0
            });
        });
        
        this.showLoading();
        
        try {
            const response = await fetch(`${this.API_BASE_URL}/invoices/create`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': localStorage.getItem('token') ? `Bearer ${localStorage.getItem('token')}` : ''
                },
                body: JSON.stringify(formData)
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.showSuccess('Invoice saved successfully!');
                this.closeModal('invoiceModal');
                await this.refreshData();
            } else {
                this.showError(`Failed to save invoice: ${result.message}`);
            }
        } catch (error) {
            console.error('Error saving invoice:', error);
            this.showError('Failed to save invoice. Please try again.');
        } finally {
            this.hideLoading();
        }
    }

    showCreateJobCardModal() {
        this.openModal('createJobCardModal');
        // You would load the job card form here
    }

    switchView(view) {
        this.currentView = view;
        
        // Update active button
        this.elements.viewBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
        
        // Show/hide views
        if (view === 'board') {
            this.elements.boardView.style.display = 'block';
            this.elements.tableView.style.display = 'none';
        } else {
            this.elements.boardView.style.display = 'none';
            this.elements.tableView.style.display = 'block';
        }
    }

    async performSearch() {
        const searchTerm = this.elements.globalSearch.value.trim();
        const filter = this.currentFilter;
        
        if (!searchTerm) {
            await this.refreshData();
            return;
        }
        
        this.showLoading();
        
        try {
            let url = `${this.API_BASE_URL}/jobcards/search?`;
            const params = new URLSearchParams();
            
            if (searchTerm) {
                if (filter === 'all') {
                    params.append('searchTerm', searchTerm);
                } else {
                    params.append('filters', filter);
                    params.append('searchTerm', searchTerm);
                }
            }
            
            params.append('limit', 100);
            
            const response = await fetch(`${url}${params}`);
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    this.jobCards = data.data;
                    this.renderJobCards();
                    this.renderJobCardsTable();
                    this.updateColumnCounts();
                }
            }
        } catch (error) {
            console.error('Error performing search:', error);
            this.showError('Search failed. Please try again.');
        } finally {
            this.hideLoading();
        }
    }

    async handleSearchInput(e) {
        const searchTerm = e.target.value.trim();
        
        if (searchTerm.length < 2) {
            this.elements.suggestionsDropdown.style.display = 'none';
            return;
        }
        
        // Show loading in suggestions
        this.elements.suggestionsDropdown.innerHTML = '<div class="suggestion-item">Searching...</div>';
        this.elements.suggestionsDropdown.style.display = 'block';
        
        try {
            const response = await fetch(
                `${this.API_BASE_URL}/jobcards/suggestions?q=${encodeURIComponent(searchTerm)}&filters=${this.currentFilter}`
            );
            
            if (response.ok) {
                const suggestions = await response.json();
                this.showSuggestions(suggestions);
            }
        } catch (error) {
            console.error('Error fetching suggestions:', error);
            this.elements.suggestionsDropdown.style.display = 'none';
        }
    }

    showSuggestions(suggestions) {
        if (!suggestions || suggestions.length === 0) {
            this.elements.suggestionsDropdown.innerHTML = '<div class="suggestion-item">No results found</div>';
            return;
        }
        
        this.elements.suggestionsDropdown.innerHTML = '';
        
        suggestions.forEach(suggestion => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.innerHTML = `
                <i class="fa-solid fa-file-invoice"></i>
                <div class="suggestion-text">
                    <div>${suggestion.job_no || suggestion.text}</div>
                    <div class="suggestion-meta">${suggestion.customer_name || ''}</div>
                </div>
            `;
            
            item.addEventListener('click', () => {
                this.elements.globalSearch.value = suggestion.job_no || suggestion.text;
                this.elements.suggestionsDropdown.style.display = 'none';
                this.performSearch();
            });
            
            this.elements.suggestionsDropdown.appendChild(item);
        });
        
        this.elements.suggestionsDropdown.style.display = 'block';
    }

    clearSearch() {
        this.elements.globalSearch.value = '';
        this.elements.suggestionsDropdown.style.display = 'none';
        this.elements.clearSearch.classList.remove('visible');
        this.refreshData();
    }

    async refreshData() {
        await this.loadInitialData();
        this.showSuccess('Data refreshed successfully!');
    }

    openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('active');
            document.body.style.overflow = 'hidden';
        }
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('active');
            document.body.style.overflow = '';
        }
    }

    showLoading() {
        if (this.elements.loadingOverlay) {
            this.elements.loadingOverlay.classList.add('active');
        }
    }

    hideLoading() {
        if (this.elements.loadingOverlay) {
            this.elements.loadingOverlay.classList.remove('active');
        }
    }

    showSuccess(message) {
        // Create notification
        const notification = document.createElement('div');
        notification.className = 'notification success';
        notification.innerHTML = `
            <i class="fa-solid fa-check-circle"></i>
            <span>${message}</span>
        `;
        
        document.body.appendChild(notification);
        
        // Remove after 3 seconds
        setTimeout(() => {
            notification.remove();
        }, 3000);
    }

    showError(message) {
        // Create error notification
        const notification = document.createElement('div');
        notification.className = 'notification error';
        notification.innerHTML = `
            <i class="fa-solid fa-exclamation-circle"></i>
            <span>${message}</span>
        `;
        
        document.body.appendChild(notification);
        
        // Remove after 5 seconds
        setTimeout(() => {
            notification.remove();
        }, 5000);
    }

    updateStats() {
        // Update stats based on current data
        const stats = {
            transit: 0,
            arrived: 0,
            completed: 0,
            revenue: 0
        };

        this.jobCards.forEach(jobCard => {
            const status = this.getJobCardStatus(jobCard);
            stats[status]++;
            
            if (jobCard.invoice_total) {
                stats.revenue += parseFloat(jobCard.invoice_total) || 0;
            }
        });

        // Update display
        this.updateStatsDisplay({
            submittedJobCards: stats.transit,
            draftJobCards: stats.arrived,
            totalJobCards: stats.completed,
            totalInvoices: stats.revenue.toFixed(3) + ' KWD'
        });
    }
}

// Initialize the dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.dashboardApp = new DashboardApp();
});

// Export for use in other modules
export { DashboardApp };