// API Configuration
const API_BASE_URL = 'https://ball-sent-epinions-protective.trycloudflare.com/api'; // Update with your backend URL

// Sample data for fallback
let jobCards = []; // Will be populated from database
let invoices = []; // Will be populated from database

// Predefined charge options
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

// DOM Elements
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const suggestionsDropdown = document.getElementById('suggestionsDropdown');
const jobCardsTableBody = document.getElementById('jobCardsTableBody');
const invoicesTableBody = document.getElementById('invoicesTableBody');
const invoiceFormContainer = document.getElementById('invoiceFormContainer');
const createNewBtn = document.getElementById('createNewBtn');
const cancelBtn = document.getElementById('cancelBtn');
const saveBtn = document.getElementById('saveBtn');
const addChargeBtn = document.getElementById('addChargeBtn');
const chargesTableBody = document.getElementById('chargesTableBody');
const totalKWD = document.getElementById('totalKWD');
const formTitle = document.getElementById('formTitle');

// Checkbox filters
const filterBayan = document.getElementById('filterBayan');
const filterInvoice = document.getElementById('filterInvoice');
const filterCustomerRef = document.getElementById('filterCustomerRef');
const filterPortArrival = document.getElementById('filterPortArrival');
const filterShipper = document.getElementById('filterShipper');

// Get active filter checkboxes
function getActiveFilter() {
    if (filterBayan.checked) return 'bayanNo';
    if (filterInvoice.checked) return 'invoiceNo';
    if (filterCustomerRef.checked) return 'customerRef';
    if (filterPortArrival.checked) return 'portArrival';
    if (filterShipper.checked) return 'shipper';
    return 'all';
}

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    loadInitialData();
    
    // Set up event listeners
    searchInput.addEventListener('input', handleSearchInput);
    searchBtn.addEventListener('click', performSearch);
    createNewBtn.addEventListener('click', showInvoiceForm);
    cancelBtn.addEventListener('click', hideInvoiceForm);
    saveBtn.addEventListener('click', saveInvoice);
    addChargeBtn.addEventListener('click', addChargeRow);
    
    // Initialize charges table with default charges
    initializeChargesTable();
});

// Load initial data from database
async function loadInitialData() {
    try {
        // Load job cards
        const jobCardsResponse = await fetchJobCards({}, 1, 10);
        if (jobCardsResponse && jobCardsResponse.length > 0) {
            jobCards = jobCardsResponse;
        }
        
        // Load invoices
        const invoicesResponse = await fetchInvoices(1, 10);
        if (invoicesResponse.success && invoicesResponse.data.length > 0) {
            invoices = invoicesResponse.data;
        }
        
        renderJobCardsTable();
        renderInvoicesTable();
        
    } catch (error) {
        console.error('Error loading initial data:', error);
        // Fallback to sample data
        initializeSampleData();
    }
}

// Fallback sample data
function initializeSampleData() {
    jobCards = [
        {
            id: 1,
            job_no: "ROA-E-2025-00382",
            bayan_no: "40984",
            invoice_no: "INV/2025/08231",
            customer_name: "DOWELL SCHLUMBERGER CORPORATION",
            shipper_name: "MUSTAFA KARAM & SONS GEN. TRAD. & CONT. CO. WLL",
            port_arrival: "Saudi Arabia",
            status: "completed"
        },
        {
            id: 2,
            job_no: "ROA-E-2025-00415",
            bayan_no: "41205",
            invoice_no: "INV/2025/08245",
            customer_name: "KUWAIT NATIONAL PETROLEUM COMPANY",
            shipper_name: "AL-JABER TRANSPORT CO.",
            port_arrival: "UAE",
            status: "in-progress"
        },
        {
            id: 3,
            job_no: "ROA-E-2025-00395",
            bayan_no: "41022",
            invoice_no: "INV/2025/08212",
            customer_name: "EQUATE PETROCHEMICAL COMPANY",
            shipper_name: "GULF SUPPLY COMPANY WLL",
            port_arrival: "Qatar",
            status: "pending"
        },
        {
            id: 4,
            job_no: "ROA-E-2025-00402",
            bayan_no: "41118",
            invoice_no: "INV/2025/08233",
            customer_name: "HALLIBURTON WORLDWIDE LTD",
            shipper_name: "AL-MULLA INTERNATIONAL TRADING",
            port_arrival: "Oman",
            status: "completed"
        }
    ];
    
    invoices = [
        {
            id: 1,
            invoice_no: "INV/2025/08231",
            date: "2025-11-10",
            customer_name: "DOWELL SCHLUMBERGER CORPORATION",
            job_no: "ROA-E-2025-00382",
            total: "82.710",
            status: "Paid"
        }
    ];
    
    renderJobCardsTable();
    renderInvoicesTable();
}

// Fetch job cards from backend
async function fetchJobCards(filters = {}, page = 1, limit = 50) {
    try {
        const params = new URLSearchParams({
            page: page.toString(),
            limit: limit.toString(),
            ...filters
        });
        
        console.log('Fetching job cards with params:', params.toString());
        
        const response = await fetch(`${API_BASE_URL}/jobcards/search?${params}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.success) {
            console.log('Job cards fetched successfully:', data.data.length, 'items');
            return data.data;
        } else {
            console.error('Failed to fetch job cards:', data.message);
            return [];
        }
    } catch (error) {
        console.error('Error fetching job cards:', error);
        return [];
    }
}

// Fetch job card suggestions
async function fetchJobCardSuggestions(searchTerm, filter = 'all') {
    try {
        const response = await fetch(
            `${API_BASE_URL}/jobcards/suggestions?q=${encodeURIComponent(searchTerm)}&filters=${filter}`
        );
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error fetching suggestions:', error);
        return [];
    }
}

// Fetch job card by ID
async function fetchJobCardById(id) {
    try {
        const response = await fetch(`${API_BASE_URL}/jobcards/${id}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.success) {
            return data.data;
        } else {
            console.error('Failed to fetch job card:', data.message);
            return null;
        }
    } catch (error) {
        console.error('Error fetching job card:', error);
        return null;
    }
}

// Fetch invoices
async function fetchInvoices(page = 1, limit = 50, status = '') {
    try {
        const params = new URLSearchParams({ 
            page: page.toString(), 
            limit: limit.toString() 
        });
        if (status) params.append('status', status);
        
        const response = await fetch(`${API_BASE_URL}/invoices?${params}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching invoices:', error);
        return { success: false, data: [], pagination: { total: 0, pages: 0 } };
    }
}

// Create invoice
async function createInvoice(invoiceData) {
    try {
        // Get authentication token
        const token = localStorage.getItem('token') || '';
        
        const response = await fetch(`${API_BASE_URL}/invoices/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': token ? `Bearer ${token}` : ''
            },
            body: JSON.stringify(invoiceData)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error creating invoice:', error);
        return { success: false, message: 'Failed to create invoice: ' + error.message };
    }
}

// Render job cards table
function renderJobCardsTable() {
    jobCardsTableBody.innerHTML = '';
    
    if (jobCards.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = `<td colspan="8" style="text-align: center; padding: 30px;">No job cards found. Create your first job card!</td>`;
        jobCardsTableBody.appendChild(row);
        return;
    }
    
    jobCards.forEach(card => {
        // Map database status to display status
        let statusClass = '';
        let statusText = '';
        
        switch(card.status?.toLowerCase()) {
            case 'completed':
            case 'paid':
                statusClass = 'status-completed';
                statusText = 'COMPLETED';
                break;
            case 'submitted':
            case 'sent':
                statusClass = 'status-in-progress';
                statusText = 'IN PROGRESS';
                break;
            case 'draft':
            case 'pending':
                statusClass = 'status-pending';
                statusText = 'PENDING';
                break;
            default:
                statusClass = 'status-pending';
                statusText = (card.status || 'PENDING').toUpperCase();
        }
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${card.job_no || card.jobNo || 'N/A'}</td>
            <td>${card.bayan_no || card.bayanNo || 'N/A'}</td>
            <td>${card.invoice_no || card.invoiceNo || 'N/A'}</td>
            <td>${card.customer_name || card.customerName || 'N/A'}</td>
            <td>${(card.shipper_name || card.shipperName || 'N/A').substring(0, 30)}${(card.shipper_name || card.shipperName || '').length > 30 ? '...' : ''}</td>
            <td>${card.port_arrival || card.portArrival || 'N/A'}</td>
            <td><span class="status ${statusClass}">${statusText}</span></td>
            <td>
                <button class="action-btn edit-btn" data-id="${card.id || card.job_no}"><i class="fas fa-edit"></i> Edit</button>
                <button class="action-btn pdf-btn" data-id="${card.id || card.job_no}"><i class="fas fa-file-pdf"></i> PDF</button>
            </td>
        `;
        
        jobCardsTableBody.appendChild(row);
    });
    
    // Add event listeners to action buttons
    addJobCardEventListeners();
}

// Add event listeners to job card buttons
function addJobCardEventListeners() {
    document.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.getAttribute('data-id');
            editJobCard(id);
        });
    });
    
    document.querySelectorAll('.pdf-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.getAttribute('data-id');
            generatePDF(id);
        });
    });
}

// Render filtered job cards
function renderFilteredJobCards(filteredCards) {
    jobCardsTableBody.innerHTML = '';
    
    if (filteredCards.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = `<td colspan="8" style="text-align: center; padding: 30px;">No job cards found matching your search criteria.</td>`;
        jobCardsTableBody.appendChild(row);
        return;
    }
    
    filteredCards.forEach(card => {
        let statusClass = '';
        let statusText = '';
        
        switch(card.status?.toLowerCase()) {
            case 'completed':
            case 'paid':
                statusClass = 'status-completed';
                statusText = 'COMPLETED';
                break;
            case 'submitted':
            case 'sent':
                statusClass = 'status-in-progress';
                statusText = 'IN PROGRESS';
                break;
            case 'draft':
            case 'pending':
                statusClass = 'status-pending';
                statusText = 'PENDING';
                break;
            default:
                statusClass = 'status-pending';
                statusText = (card.status || 'PENDING').toUpperCase();
        }
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${card.job_no || card.jobNo || 'N/A'}</td>
            <td>${card.bayan_no || card.bayanNo || 'N/A'}</td>
            <td>${card.invoice_no || card.invoiceNo || 'N/A'}</td>
            <td>${card.customer_name || card.customerName || 'N/A'}</td>
            <td>${(card.shipper_name || card.shipperName || 'N/A').substring(0, 30)}${(card.shipper_name || card.shipperName || '').length > 30 ? '...' : ''}</td>
            <td>${card.port_arrival || card.portArrival || 'N/A'}</td>
            <td><span class="status ${statusClass}">${statusText}</span></td>
            <td>
                <button class="action-btn edit-btn" data-id="${card.id || card.job_no}"><i class="fas fa-edit"></i> Edit</button>
                <button class="action-btn pdf-btn" data-id="${card.id || card.job_no}"><i class="fas fa-file-pdf"></i> PDF</button>
            </td>
        `;
        
        jobCardsTableBody.appendChild(row);
    });
    
    // Re-add event listeners
    addJobCardEventListeners();
}

// Handle search input with suggestions
async function handleSearchInput() {
    const searchTerm = searchInput.value.trim();
    
    if (searchTerm.length < 2) {
        suggestionsDropdown.style.display = 'none';
        return;
    }
    
    const activeFilter = getActiveFilter();
    const suggestions = await fetchJobCardSuggestions(searchTerm, activeFilter);
    
    if (suggestions.length === 0) {
        suggestionsDropdown.style.display = 'none';
        return;
    }
    
    // Display suggestions
    suggestionsDropdown.innerHTML = '';
    suggestions.forEach(suggestion => {
        const suggestionItem = document.createElement('div');
        suggestionItem.className = 'suggestion-item';
        suggestionItem.textContent = suggestion.text || suggestion.job_no;
        suggestionItem.setAttribute('data-id', suggestion.id || suggestion.job_no);
        
        suggestionItem.addEventListener('click', function() {
            const id = this.getAttribute('data-id');
            selectJobCardFromSuggestion(suggestion);
            suggestionsDropdown.style.display = 'none';
            searchInput.value = '';
        });
        
        suggestionsDropdown.appendChild(suggestionItem);
    });
    
    suggestionsDropdown.style.display = 'block';
}

// Select a job card from search suggestions
function selectJobCardFromSuggestion(suggestion) {
    // Fill the form with job card data from suggestion
    fillInvoiceFormFromSuggestion(suggestion);
    showInvoiceForm();
}

// Fill invoice form with job card data from suggestion
function fillInvoiceFormFromSuggestion(card) {
    // Set basic job card info
    document.getElementById('customer').value = card.customer_name || card.customerName || '';
    document.getElementById('jobNo').value = card.job_no || card.jobNo || '';
    document.getElementById('bayanNo').value = card.bayan_no || card.bayanNo || '';
    document.getElementById('portArrival').value = card.port_arrival || card.portArrival || '';
    document.getElementById('shipper').value = card.shipper_name || card.shipperName || '';
    document.getElementById('shipperRef').value = card.shipper_ref_no || card.shipperRef || '';
    
    // Set dates
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('invoiceDate').value = today;
    
    // Generate invoice number
    const year = new Date().getFullYear();
    const randomNum = Math.floor(Math.random() * 90000) + 10000;
    document.getElementById('invoiceNo').value = `INV/${year}/${randomNum}`;
    
    // Clear truck waybill if it's the same as job number (avoid duplication)
    if (!card.truck_waybill_no && !card.truckWaybill) {
        document.getElementById('truckWaybill').value = '';
    } else {
        document.getElementById('truckWaybill').value = card.truck_waybill_no || card.truckWaybill || '';
    }
    
    // Set default charges for this job card
    const defaultCharges = [
        { description: "CUSTOMS CLEARANCE SERVICE CHARGE (NUWASIB)", qty: 1, unitAmount: 30.000, amount: 30.00 },
        { description: "INSPECTION CHARGES", qty: 1, unitAmount: 10.000, amount: 10.00 },
        { description: "GLOBAL CLEARINGHOUSE SYSTEMS CHARGES", qty: 1, unitAmount: 27.210, amount: 27.21 }
    ];
    
    renderChargesTable(defaultCharges);
    updateTotal();
    
    formTitle.textContent = 'Create Invoice from Job Card';
}

// Perform search (filter job cards table)
async function performSearch() {
    const searchTerm = searchInput.value.trim();
    
    if (searchTerm === '') {
        // If no search term, show all job cards
        await loadInitialData();
        return;
    }
    
    const activeFilter = getActiveFilter();
    const filters = {};
    
    if (searchTerm) {
        if (activeFilter !== 'all') {
            filters.filters = activeFilter;
            filters.searchTerm = searchTerm;
        } else {
            filters.searchTerm = searchTerm;
        }
    }
    
    const results = await fetchJobCards(filters);
    renderFilteredJobCards(results);
}

// Edit job card
async function editJobCard(id) {
    const card = await fetchJobCardById(id);
    if (!card) {
        alert('Job card not found in database');
        return;
    }
    
    fillInvoiceForm(card);
    formTitle.textContent = 'Edit Invoice';
    showInvoiceForm();
}

// Fill invoice form with full job card data
function fillInvoiceForm(card) {
    document.getElementById('customer').value = card.customer_name || card.customerName || '';
    document.getElementById('invoiceNo').value = card.invoice_no || card.invoiceNo || '';
    document.getElementById('jobNo').value = card.job_no || card.jobNo || '';
    document.getElementById('bayanNo').value = card.bayan_no || card.bayanNo || '';
    document.getElementById('truckWaybill').value = card.truck_waybill_no || card.truckWaybill || '';
    document.getElementById('portDeparture').value = card.port_departure || 'Kuwait';
    document.getElementById('portArrival').value = card.port_arrival || card.portArrival || '';
    document.getElementById('shipper').value = card.shipper_name || card.shipperName || '';
    document.getElementById('shipperRef').value = card.shipper_ref_no || card.shipperRef || '';
    document.getElementById('grossWeight').value = card.gross_weight || card.grossWeight || '';
    document.getElementById('packages').value = card.packages || 1;
    
    // Set dates
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('invoiceDate').value = today;
    document.getElementById('bayanDate').value = card.bayan_date || card.bayanDate || today;
    document.getElementById('eta').value = card.eta || today;
    
    // Set default charges
    const defaultCharges = [
        { description: "CUSTOMS CLEARANCE SERVICE CHARGE (NUWASIB)", qty: 1, unitAmount: 30.000, amount: 30.00 },
        { description: "INSPECTION CHARGES", qty: 1, unitAmount: 10.000, amount: 10.00 },
        { description: "GLOBAL CLEARINGHOUSE SYSTEMS CHARGES", qty: 1, unitAmount: 27.210, amount: 27.21 }
    ];
    
    renderChargesTable(defaultCharges);
    updateTotal();
}

// Show invoice form
function showInvoiceForm() {
    invoiceFormContainer.style.display = 'block';
    window.scrollTo({
        top: invoiceFormContainer.offsetTop - 100,
        behavior: 'smooth'
    });
}

// Hide invoice form
function hideInvoiceForm() {
    invoiceFormContainer.style.display = 'none';
    formTitle.textContent = 'Create Invoice';
    // Reset form to default values
    initializeChargesTable();
}

// Initialize charges table with default charges
function initializeChargesTable() {
    const defaultCharges = [
        { description: "CUSTOMS CLEARANCE SERVICE CHARGE (NUWASIB)", qty: 1, unitAmount: 30.000, amount: 30.00 },
        { description: "INSPECTION CHARGES", qty: 1, unitAmount: 10.000, amount: 10.00 },
        { description: "GLOBAL CLEARINGHOUSE SYSTEMS CHARGES", qty: 1, unitAmount: 27.210, amount: 27.21 }
    ];
    
    renderChargesTable(defaultCharges);
    updateTotal();
}

// Render charges table
function renderChargesTable(charges) {
    chargesTableBody.innerHTML = '';
    
    charges.forEach((charge, index) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${index + 1}</td>
            <td>
                <select class="form-control charge-description">
                    ${chargeOptions.map(option => 
                        `<option value="${option}" ${option === charge.description ? 'selected' : ''}>${option}</option>`
                    ).join('')}
                </select>
            </td>
            <td><input type="number" class="form-control charge-qty" value="${charge.qty}" min="1" step="1"></td>
            <td><input type="number" class="form-control charge-unit-amount" value="${charge.unitAmount}" min="0" step="0.001"></td>
            <td><input type="text" class="form-control charge-amount" value="${charge.amount.toFixed(3)}" readonly></td>
            <td><button type="button" class="action-btn delete-btn remove-charge"><i class="fas fa-trash"></i></button></td>
        `;
        
        chargesTableBody.appendChild(row);
    });
    
    // Add event listeners to charge inputs
    addChargeEventListeners();
}

// Add charge row
function addChargeRow() {
    const newRow = document.createElement('tr');
    const rowCount = chargesTableBody.children.length + 1;
    
    newRow.innerHTML = `
        <td>${rowCount}</td>
        <td>
            <select class="form-control charge-description">
                ${chargeOptions.map(option => `<option value="${option}">${option}</option>`).join('')}
            </select>
        </td>
        <td><input type="number" class="form-control charge-qty" value="1" min="1" step="1"></td>
        <td><input type="number" class="form-control charge-unit-amount" value="0.000" min="0" step="0.001"></td>
        <td><input type="text" class="form-control charge-amount" value="0.000" readonly></td>
        <td><button type="button" class="action-btn delete-btn remove-charge"><i class="fas fa-trash"></i></button></td>
    `;
    
    chargesTableBody.appendChild(newRow);
    
    // Add event listeners to the new row
    addChargeEventListenersToRow(newRow);
}

// Add event listeners to charge inputs
function addChargeEventListeners() {
    // Remove charge buttons
    document.querySelectorAll('.remove-charge').forEach(btn => {
        btn.addEventListener('click', function() {
            this.closest('tr').remove();
            updateRowNumbers();
            updateTotal();
        });
    });
    
    // Quantity and unit amount inputs
    document.querySelectorAll('.charge-qty, .charge-unit-amount').forEach(input => {
        input.addEventListener('input', updateChargeAmount);
    });
}

// Add event listeners to a specific row
function addChargeEventListenersToRow(row) {
    // Remove charge button
    row.querySelector('.remove-charge').addEventListener('click', function() {
        this.closest('tr').remove();
        updateRowNumbers();
        updateTotal();
    });
    
    // Quantity and unit amount inputs
    row.querySelectorAll('.charge-qty, .charge-unit-amount').forEach(input => {
        input.addEventListener('input', updateChargeAmount);
    });
}

// Update charge amount when qty or unit amount changes
function updateChargeAmount() {
    const row = this.closest('tr');
    const qty = parseFloat(row.querySelector('.charge-qty').value) || 0;
    const unitAmount = parseFloat(row.querySelector('.charge-unit-amount').value) || 0;
    const amount = qty * unitAmount;
    
    row.querySelector('.charge-amount').value = amount.toFixed(3);
    updateTotal();
}

// Update row numbers in charges table
function updateRowNumbers() {
    const rows = chargesTableBody.querySelectorAll('tr');
    rows.forEach((row, index) => {
        row.cells[0].textContent = index + 1;
    });
}

// Update total amount
function updateTotal() {
    let total = 0;
    
    document.querySelectorAll('.charge-amount').forEach(input => {
        total += parseFloat(input.value) || 0;
    });
    
    totalKWD.value = total.toFixed(3);
    
    // Update amount in words
    updateAmountInWords(total);
}

// Convert number to words (simplified version)
function updateAmountInWords(amount) {
    const wholePart = Math.floor(amount);
    const fractionalPart = Math.round((amount - wholePart) * 1000);
    
    // Convert whole part to words
    const wholeWords = convertNumberToWords(wholePart);
    
    // Convert fractional part to words
    const fractionalWords = convertNumberToWords(fractionalPart);
    
    // Build the final string
    let words = '';
    
    if (wholePart > 0) {
        words += `${wholeWords} Dinar`;
        if (wholePart !== 1) words += 's';
    }
    
    if (fractionalPart > 0) {
        if (wholePart > 0) words += ' and ';
        words += `${fractionalWords} Fils`;
    }
    
    if (words === '') {
        words = 'Zero Dinar';
    }
    
    words += ' only';
    
    // Capitalize first letter
    words = words.charAt(0).toUpperCase() + words.slice(1);
    
    document.getElementById('amountWords').value = words;
}

// Simplified number to words conversion
function convertNumberToWords(num) {
    if (num === 0) return 'zero';
    
    const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const teens = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    
    if (num < 10) return ones[num];
    if (num < 20) return teens[num - 10];
    if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 !== 0 ? '-' + ones[num % 10] : '');
    
    // For simplicity, we'll return a basic representation for larger numbers
    return num.toString();
}

// Save invoice
// Save invoice - UPDATED VERSION
async function saveInvoice() {
    // Collect form data
    const jobNo = document.getElementById('jobNo').value;
    const invoiceData = {
        jobCardId: jobNo, // This should be the job_no from the form
        invoiceData: {
            invoiceDate: document.getElementById('invoiceDate').value,
            invoiceNo: document.getElementById('invoiceNo').value,
            notes: ''
        },
        charges: []
    };
    
    // Collect charges
    document.querySelectorAll('#chargesTableBody tr').forEach(row => {
        invoiceData.charges.push({
            description: row.querySelector('.charge-description').value,
            qty: parseFloat(row.querySelector('.charge-qty').value) || 0,
            unitAmount: parseFloat(row.querySelector('.charge-unit-amount').value) || 0,
            amount: parseFloat(row.querySelector('.charge-amount').value) || 0
        });
    });
    
    console.log('Saving invoice data:', invoiceData);
    
    // Send to backend
    const result = await createInvoice(invoiceData);
    
    if (result.success) {
        alert(`Invoice ${result.invoiceNumber || invoiceData.invoiceData.invoiceNo} saved successfully!`);
        hideInvoiceForm();
        
        // Refresh invoices table
        await loadRecentInvoices();
    } else {
        alert(`Failed to save invoice: ${result.message}`);
        if (result.details) {
            console.error('Invoice creation error details:', result.details);
        }
    }
}


// Render invoices table
function renderInvoicesTable() {
    invoicesTableBody.innerHTML = '';
    
    if (invoices.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = `<td colspan="7" style="text-align: center; padding: 30px;">No invoices created yet. Create your first invoice!</td>`;
        invoicesTableBody.appendChild(row);
        return;
    }
    
    invoices.forEach(invoice => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${invoice.invoice_no || invoice.invoiceNo || 'N/A'}</td>
            <td>${invoice.date || 'N/A'}</td>
            <td>${invoice.customer_name || invoice.customerName || 'N/A'}</td>
            <td>${invoice.job_no || invoice.jobNo || 'N/A'}</td>
            <td>${parseFloat(invoice.total || invoice.total_amount || 0).toFixed(3)} KWD</td>
            <td><span class="status status-completed">${invoice.status || 'Paid'}</span></td>
            <td>
                <button class="action-btn pdf-btn" data-invoice-id="${invoice.id || invoice.invoice_no}"><i class="fas fa-file-pdf"></i> PDF</button>
                <button class="action-btn delete-btn" data-invoice-id="${invoice.id || invoice.invoice_no}"><i class="fas fa-trash"></i></button>
            </td>
        `;
        
        invoicesTableBody.appendChild(row);
    });
    
    // Add event listeners to invoice action buttons
    document.querySelectorAll('.pdf-btn[data-invoice-id]').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.getAttribute('data-invoice-id');
            generateInvoicePDF(id);
        });
    });
    
    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.getAttribute('data-invoice-id');
            deleteInvoice(id);
        });
    });
}

// Generate PDF for job card
function generatePDF(id) {
    alert(`Generating PDF for Job Card: ${id}\n\nIn a real application, this would generate a PDF file.`);
}

// Generate PDF for invoice
async function generateInvoicePDF(id) {
    try {
        // Open PDF in new window
        window.open(`${API_BASE_URL}/invoices/${id}/pdf`, '_blank');
    } catch (error) {
        console.error('Error generating PDF:', error);
        alert('Failed to generate PDF. Please try again.');
    }
}

// Delete invoice
async function deleteInvoice(id) {
    if (confirm('Are you sure you want to delete this invoice?')) {
        try {
            const response = await fetch(`${API_BASE_URL}/invoices/${id}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': localStorage.getItem('token') ? `Bearer ${localStorage.getItem('token')}` : ''
                }
            });
            
            const data = await response.json();
            
            if (data.success) {
                // Refresh invoices
                await loadRecentInvoices();
                alert('Invoice deleted successfully');
            } else {
                alert('Failed to delete invoice: ' + data.message);
            }
        } catch (error) {
            console.error('Error deleting invoice:', error);
            alert('Failed to delete invoice');
        }
    }
}