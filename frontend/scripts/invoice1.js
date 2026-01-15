
    // API Configuration
    let API_BASE_URL = '';
    if (window.CONFIG && window.CONFIG.API_BASE_URL) {
        API_BASE_URL = window.CONFIG.API_BASE_URL + '/api';
    }

    // DOM Elements
    const mobileMenuToggle = document.getElementById('mobileMenuToggle');
    const boardView = document.getElementById('boardView');
    const tableView = document.getElementById('tableView');
    const viewButtons = document.querySelectorAll('.view-btn');
    const createJobCardBtn = document.getElementById('createJobCardBtn');
    const loadingOverlay = document.getElementById('loadingOverlay');
    
    // State management
    let currentJobCards = [];
    let chargeTypes = [];
    
    // Initialize the application
    document.addEventListener('DOMContentLoaded', function() {
        initViewToggle();
        loadJobCards();
        initSearch();
        loadChargeTypes();
    });

    // View toggle functionality
    function initViewToggle() {
        viewButtons.forEach(btn => {
            btn.addEventListener('click', function() {
                const view = this.getAttribute('data-view');
                
                // Update active button
                viewButtons.forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                
                // Show/hide views
                if (view === 'board') {
                    boardView.style.display = 'block';
                    tableView.classList.remove('active');
                } else if (view === 'table') {
                    boardView.style.display = 'none';
                    tableView.classList.add('active');
                }
            });
        });
    }

    // Load job cards from API
    async function loadJobCards() {
        showLoading();
        
        try {
            const response = await fetch(`${API_BASE_URL}/jobcards`);
            const result = await response.json();
            
            if (!result.success) {
                throw new Error(result.message);
            }
            
            currentJobCards = result.data;
            
            // Clear existing cards
            document.getElementById('colTransit').innerHTML = '';
            document.getElementById('colArrived').innerHTML = '';
            document.getElementById('colCompleted').innerHTML = '';
            document.getElementById('jobCardsTableBody').innerHTML = '';
            
            // Counters
            let transitCount = 0;
            let arrivedCount = 0;
            let completedCount = 0;
            let totalMargin = 0;
            
            // Process each job card
            currentJobCards.forEach(card => {
                // Determine status based on database status
                let status = 'in-transit';
                let statusDisplay = 'IN TRANSIT';
                
                switch(card.status) {
                    case 'draft':
                    case 'submitted':
                        status = 'in-transit';
                        statusDisplay = 'IN TRANSIT';
                        break;
                    case 'approved':
                        status = 'arrived';
                        statusDisplay = 'ARRIVED';
                        break;
                    case 'completed':
                        status = 'completed';
                        statusDisplay = 'COMPLETED';
                        break;
                }
                
                // Determine type from job number
                let type = 'AIR';
                let typeClass = 'job-type-air';
                let typeIcon = '✈️';
                let typeDisplay = 'AIR';
                
                if (card.job_no.includes('SEA')) {
                    type = 'SEA';
                    typeClass = 'job-type-sea';
                    typeIcon = '🚢';
                    typeDisplay = 'SEA';
                } else if (card.job_no.includes('ROA')) {
                    type = 'ROA';
                    typeClass = 'job-type-road';
                    typeIcon = '🚚';
                    typeDisplay = 'ROAD';
                } else if (card.job_no.includes('MUL')) {
                    type = 'MUL';
                    typeClass = 'job-type-road';
                    typeIcon = '🚚';
                    typeDisplay = 'MULTI';
                }
                
                // Get HBL number
                const hblNumber = card.hbl || card.habw || card.truck_waybill_no || 'N/A';
                
                // Prepare template data
                const templateData = {
                    id: card.id,
                    job_no: card.job_no,
                    hbl_number: hblNumber,
                    type: type,
                    departure_location: card.departure_location || 'N/A',
                    arrival_location: card.arrival_location || 'N/A',
                    customer_name: card.customer_name || 'N/A',
                    shipper_name: card.shipper_name || 'N/A',
                    consignee_name: card.requester_name || 'N/A', // Using customer as consignee
                    created_by: card.created_by || 'System',
                    status: status,
                    status_class: `status-${status}`,
                    status_display: statusDisplay,
                    type_class: typeClass,
                    type_icon: typeIcon,
                    type_display: typeDisplay,
                    receivable_estimated: card.invoice_total ? parseFloat(card.invoice_total).toFixed(3) : '0.000',
                    receivable_actual: card.invoice_total ? parseFloat(card.invoice_total).toFixed(3) : '0.000',
                    payable_estimated: '0.000', // You can calculate this later
                    payable_actual: '0.000', // You can calculate this later
                    margin_estimated: card.invoice_total ? parseFloat(card.invoice_total).toFixed(3) : '0.000',
                    margin_actual: card.invoice_total ? parseFloat(card.invoice_total).toFixed(3) : '0.000'
                };
                
                // Create board card
                const template = document.getElementById('jobCardTemplate').innerHTML;
                const cardHtml = template.replace(/{{(\w+)}}/g, (match, key) => templateData[key] || '');
                
                // Add to appropriate column
                switch(status) {
                    case 'in-transit':
                        document.getElementById('colTransit').insertAdjacentHTML('beforeend', cardHtml);
                        transitCount++;
                        break;
                    case 'arrived':
                        document.getElementById('colArrived').insertAdjacentHTML('beforeend', cardHtml);
                        arrivedCount++;
                        break;
                    case 'completed':
                        document.getElementById('colCompleted').insertAdjacentHTML('beforeend', cardHtml);
                        completedCount++;
                        break;
                }
                
                // Create table row
                const tableTemplate = document.getElementById('tableRowTemplate').innerHTML;
                const rowHtml = tableTemplate.replace(/{{(\w+)}}/g, (match, key) => templateData[key] || '');
                document.getElementById('jobCardsTableBody').insertAdjacentHTML('beforeend', rowHtml);
                
                // Add to total margin
                if (card.invoice_total) {
                    totalMargin += parseFloat(card.invoice_total);
                }
            });
            
            // Update counters
            document.getElementById('transitCount').textContent = transitCount;
            document.getElementById('arrivedCount').textContent = arrivedCount;
            document.getElementById('completedCount').textContent = completedCount;
            document.getElementById('statTransit').textContent = transitCount;
            document.getElementById('statArrived').textContent = arrivedCount;
            document.getElementById('statCompleted').textContent = completedCount;
            document.getElementById('statRevenue').textContent = `${totalMargin.toFixed(3)} KWD`;
            
            // Attach event listeners to wizard buttons
            attachWizardListeners();
            
        } catch (error) {
            console.error('Error loading job cards:', error);
            alert('Failed to load job cards. Please try again.');
        } finally {
            hideLoading();
        }
    }

    // Load charge types from API
    async function loadChargeTypes() {
        try {
            const response = await fetch(`${API_BASE_URL}/charge-types`);
            const result = await response.json();
            
            if (result.success) {
                chargeTypes = result.data;
            }
        } catch (error) {
            console.error('Error loading charge types:', error);
        }
    }

    // Attach wizard button listeners
    function attachWizardListeners() {
        document.querySelectorAll('.open-wizard-btn').forEach(btn => {
            btn.addEventListener('click', async function(e) {
                e.preventDefault();
                const jobId = this.getAttribute('data-job-id');
                await openChargesWizard(jobId);
            });
        });
    }

  // Open charges wizard in new window
async function openChargesWizard(jobId) {
    try {
        // Fetch job card details
        const response = await fetch(`${API_BASE_URL}/jobcards/${jobId}/details`);
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message);
        }
        
        const jobCard = result.data;
        
        // Fetch charge types
        const chargeTypesResponse = await fetch(`${API_BASE_URL}/charge-types`);
        const chargeTypesResult = await chargeTypesResponse.json();
        const chargeTypes = chargeTypesResult.success ? chargeTypesResult.data : [];
        
        // Encode data for URL
        const encodedJobCard = encodeURIComponent(JSON.stringify(jobCard));
        const encodedChargeTypes = encodeURIComponent(JSON.stringify(chargeTypes));
        
        // Open wizard in SAME TAB
        const wizardUrl = `charges-wizard1.html?jobId=${jobId}&jobCard=${encodedJobCard}&chargeTypes=${encodedChargeTypes}`;
        window.location.href = wizardUrl;
            
        } catch (error) {
            console.error('Error opening wizard:', error);
            alert('Failed to open charges wizard: ' + error.message);
        }
    }


    // Search functionality
    function initSearch() {
        const searchInput = document.getElementById('globalSearch');
        const clearSearch = document.getElementById('clearSearch');
        const searchBtn = document.querySelector('.btn-search');
        
        clearSearch.addEventListener('click', function() {
            searchInput.value = '';
            searchInput.focus();
        });
        
        searchBtn.addEventListener('click', function() {
            const searchTerm = searchInput.value.trim().toLowerCase();
            if (searchTerm) {
                filterJobCards(searchTerm);
            } else {
                loadJobCards();
            }
        });
        
        searchInput.addEventListener('keyup', function(e) {
            if (e.key === 'Enter') {
                const searchTerm = searchInput.value.trim().toLowerCase();
                if (searchTerm) {
                    filterJobCards(searchTerm);
                }
            }
        });
    }

    function filterJobCards(searchTerm) {
        const filteredCards = currentJobCards.filter(card => 
            card.job_no.toLowerCase().includes(searchTerm) ||
            (card.hbl && card.hbl.toLowerCase().includes(searchTerm)) ||
            (card.habw && card.habw.toLowerCase().includes(searchTerm)) ||
            (card.truck_waybill_no && card.truck_waybill_no.toLowerCase().includes(searchTerm)) ||
            card.customer_name.toLowerCase().includes(searchTerm) ||
            card.shipper_name.toLowerCase().includes(searchTerm) ||
            card.departure_location.toLowerCase().includes(searchTerm) ||
            card.arrival_location.toLowerCase().includes(searchTerm)
        );
        
        // Update display with filtered cards
        renderFilteredJobCards(filteredCards);
    }

    function renderFilteredJobCards(cards) {
        // Clear existing cards
        document.getElementById('colTransit').innerHTML = '';
        document.getElementById('colArrived').innerHTML = '';
        document.getElementById('colCompleted').innerHTML = '';
        document.getElementById('jobCardsTableBody').innerHTML = '';
        
        // Counters
        let transitCount = 0;
        let arrivedCount = 0;
        let completedCount = 0;
        
        // Process each filtered card
        cards.forEach(card => {
            // Determine status based on database status
            let status = 'in-transit';
            let statusDisplay = 'IN TRANSIT';
            
            switch(card.status) {
                case 'draft':
                case 'submitted':
                    status = 'in-transit';
                    statusDisplay = 'IN TRANSIT';
                    break;
                case 'approved':
                    status = 'arrived';
                    statusDisplay = 'ARRIVED';
                    break;
                case 'completed':
                    status = 'completed';
                    statusDisplay = 'COMPLETED';
                    break;
            }
            
            // Determine type from job number
            let type = 'AIR';
            let typeClass = 'job-type-air';
            let typeIcon = '✈️';
            let typeDisplay = 'AIR';
            
            if (card.job_no.includes('SEA')) {
                type = 'SEA';
                typeClass = 'job-type-sea';
                typeIcon = '🚢';
                typeDisplay = 'SEA';
            } else if (card.job_no.includes('ROA')) {
                type = 'ROA';
                typeClass = 'job-type-road';
                typeIcon = '🚚';
                typeDisplay = 'ROAD';
            } else if (card.job_no.includes('MUL')) {
                type = 'MUL';
                typeClass = 'job-type-road';
                typeIcon = '🚚';
                typeDisplay = 'MULTI';
            }
            
            // Get HBL number
            const hblNumber = card.hbl || card.habw || card.truck_waybill_no || 'N/A';
            
            // Prepare template data
            const templateData = {
                id: card.id,
                job_no: card.job_no,
                hbl_number: hblNumber,
                type: type,
                departure_location: card.departure_location || 'N/A',
                arrival_location: card.arrival_location || 'N/A',
                customer_name: card.customer_name || 'N/A',
                shipper_name: card.shipper_name || 'N/A',
                consignee_name: card.customer_name || 'N/A',
                created_by: card.created_by || 'System',
                status: status,
                status_class: 'status-' + status,
                status_display: statusDisplay,
                type_class: typeClass,
                type_icon: typeIcon,
                type_display: typeDisplay,
                receivable_estimated: card.invoice_total ? parseFloat(card.invoice_total).toFixed(3) : '0.000',
                receivable_actual: card.invoice_total ? parseFloat(card.invoice_total).toFixed(3) : '0.000',
                payable_estimated: '0.000',
                payable_actual: '0.000',
                margin_estimated: card.invoice_total ? parseFloat(card.invoice_total).toFixed(3) : '0.000',
                margin_actual: card.invoice_total ? parseFloat(card.invoice_total).toFixed(3) : '0.000'
            };
            
            // Create board card
            const template = document.getElementById('jobCardTemplate').innerHTML;
            const cardHtml = template.replace(/{{(\w+)}}/g, (match, key) => templateData[key] || '');
            
            // Add to appropriate column
            switch(status) {
                case 'in-transit':
                    document.getElementById('colTransit').insertAdjacentHTML('beforeend', cardHtml);
                    transitCount++;
                    break;
                case 'arrived':
                    document.getElementById('colArrived').insertAdjacentHTML('beforeend', cardHtml);
                    arrivedCount++;
                    break;
                case 'completed':
                    document.getElementById('colCompleted').insertAdjacentHTML('beforeend', cardHtml);
                    completedCount++;
                    break;
            }
            
            // Create table row
            const tableTemplate = document.getElementById('tableRowTemplate').innerHTML;
            const rowHtml = tableTemplate.replace(/{{(\w+)}}/g, (match, key) => templateData[key] || '');
            document.getElementById('jobCardsTableBody').insertAdjacentHTML('beforeend', rowHtml);
        });
        
        // Update counters
        document.getElementById('transitCount').textContent = transitCount;
        document.getElementById('arrivedCount').textContent = arrivedCount;
        document.getElementById('completedCount').textContent = completedCount;
        document.getElementById('statTransit').textContent = transitCount;
        document.getElementById('statArrived').textContent = arrivedCount;
        document.getElementById('statCompleted').textContent = completedCount;
        
        // Attach event listeners to wizard buttons
        attachWizardListeners();
    }

    // Loading overlay
    function showLoading() {
        loadingOverlay.classList.add('active');
    }

    function hideLoading() {
        loadingOverlay.classList.remove('active');
    }
