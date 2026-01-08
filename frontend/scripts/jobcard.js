// Job Card JavaScript with Enhanced Dropdown Functionality
document.addEventListener('DOMContentLoaded', function() {
    // Initialize the job card system
    initJobCardSystem();
    
    // Update system time
    updateSystemTime();
    setInterval(updateSystemTime, 1000);
    
    // Update stats from database
    updateStats();

    // Start periodic job number refresh every 10 seconds
    startJobNumberRefresh();
});


// Add this function to start periodic refresh
function startJobNumberRefresh() {
    // Fetch immediately on load
    fetchNextJobNumber();
    
    // Then fetch every 10 seconds
    setInterval(fetchNextJobNumber, 10000);
    
    console.log('Job number refresh interval started: 10 seconds');
}


function initJobCardSystem() {
    // Generate job number
    generateJobNumber();
    
    // Initialize date fields
    initializeDates();
    
    // Setup enhanced auto-suggestions with proper dropdowns
    setupEnhancedAutocomplete();
    
    // Setup form submission
    const jobCardForm = document.getElementById('jobCardForm');
    if (jobCardForm) {
        jobCardForm.addEventListener('submit', handleJobCardSubmit);
    }
    
    // Setup real-time preview
    setupRealTimePreview();
    
    // Setup edit button functionality
    setupEditButtons();
    
    // Add enhanced CSS styles
    addEnhancedStyles();
    
    // NEW: Add event listeners for mode and type changes
    setupModeTypeListeners();
    setupModalCloseButtons();

}

function setupModalCloseButtons() {
    // Close modal when clicking on overlay
    const modals = document.querySelectorAll('.modal-overlay');
    modals.forEach(modal => {
        modal.addEventListener('click', function(e) {
            if (e.target === this) {
                this.classList.remove('active');
                document.body.style.overflow = 'auto';
            }
        });
    });
}

// Add this function to format date-time strings
function formatDateTime(dateTimeString) {
    if (!dateTimeString || dateTimeString === 'Not Set') return 'Not Set';
    
    try {
        const date = new Date(dateTimeString);
        
        // If it's a valid date, format it
        if (!isNaN(date.getTime())) {
            return date.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            }) + ' ' + date.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        } else {
            // Try to parse as just time if it's not a full datetime
            return dateTimeString;
        }
    } catch (e) {
        console.log('Error formatting datetime:', e, dateTimeString);
        return dateTimeString;
    }
}

function setupModeTypeListeners() {
    const modeSelect = document.getElementById('modeOfTravel');
    const typeSelect = document.getElementById('shipmentType');
    
    if (modeSelect) {
        modeSelect.addEventListener('change', function() {
            if (modeSelect.value && document.getElementById('shipmentType').value) {
                fetchNextJobNumber();
            }
        });
    }
    
    if (typeSelect) {
        typeSelect.addEventListener('change', function() {
            if (typeSelect.value && document.getElementById('modeOfTravel').value) {
                fetchNextJobNumber();
            }
        });
    }
}

// Update fetchNextJobNumber to only fill if empty
async function fetchNextJobNumber() {
    try {
        const modeSelect = document.getElementById('modeOfTravel');
        const typeSelect = document.getElementById('shipmentType');
        const jobNoField = document.getElementById('jobNo');
        
        const mode = modeSelect ? modeSelect.value : 'ROA';
        const type = typeSelect ? typeSelect.value : 'I';
        
        if (!mode || !type) {
            console.log('Mode or Type not selected, skipping job number fetch');
            return;
        }
        
        const response = await fetch(`https://powerpoint-fruit-valves-succeed.trycloudflare.com/api/jobcards/next-number?mode=${mode}&type=${type}`);
        const data = await response.json();
        
        console.log('Next job number response:', data);
        
        if (jobNoField && data.nextJobNumber) {
            // Only set if field is empty or contains a temporary number
            const currentValue = jobNoField.value;
            const isTemporary = !currentValue || 
                               currentValue.includes('JC-') || 
                               currentValue === jobNoField.dataset.previewNumber;
            
            if (isTemporary) {
                jobNoField.value = data.nextJobNumber;
                jobNoField.dataset.previewNumber = data.nextJobNumber;
                
                // Make it editable but show it's auto-generated
                jobNoField.readOnly = false;
                jobNoField.classList.remove('auto-filled');
                
                // Add info text
                if (!jobNoField.nextElementSibling || 
                    !jobNoField.nextElementSibling.classList.contains('field-hint')) {
                    const hint = document.createElement('small');
                    hint.className = 'field-hint';
                    hint.style.display = 'block';
                    hint.style.marginTop = '5px';
                    hint.style.color = '#6b7280';
                    hint.style.fontSize = '12px';
                    hint.textContent = 'Auto-generated. You can edit if needed.';
                    jobNoField.parentNode.appendChild(hint);
                }
            }
            
            return data.nextJobNumber;
        }
        
    } catch (error) {
        console.error('Error fetching next job number:', error);
        // Don't show fallback - let user enter manually
    }
}



// Add this helper function to check if job number already exists
async function checkJobNumberExists(jobNumber) {
    try {
        const response = await fetch(`https://powerpoint-fruit-valves-succeed.trycloudflare.com/api/jobcards/check-number?jobNo=${encodeURIComponent(jobNumber)}`);
        const data = await response.json();
        return data.exists || false;
    } catch (error) {
        console.error('Error checking job number:', error);
        return false;
    }
}



function generateJobNumber() {
    const jobNoField = document.getElementById('jobNo');
    const modeSelect = document.getElementById('modeOfTravel');
    const typeSelect = document.getElementById('shipmentType');
    
    if (jobNoField) {
        // Check if this is a new form (no value yet)
        const isNewForm = !jobNoField.value || 
                         jobNoField.value.trim() === '' || 
                         jobNoField.value.includes('JC-') ||
                         jobNoField.value === jobNoField.dataset.previewNumber;
        
        // Only auto-generate if mode and type are selected AND it's a new form
        if (isNewForm && modeSelect && typeSelect && modeSelect.value && typeSelect.value) {
            fetchNextJobNumber();
        }
    }
}

function initializeDates() {
    const now = new Date();
    
    // Set current date as default
    const dateField = document.getElementById('date');
    if (dateField) {
        dateField.value = now.toISOString().split('T')[0];
    }
    
    // Set ESTD to current time + 1 day
    const estdField = document.getElementById('estd');
    if (estdField) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0); // Set to 9 AM tomorrow
        estdField.value = tomorrow.toISOString().slice(0, 16);
    }
    
    // Set ETA to current time + 3 days
    const etaField = document.getElementById('eta');
    if (etaField) {
        const inThreeDays = new Date(now);
        inThreeDays.setDate(inThreeDays.getDate() + 3);
        inThreeDays.setHours(9, 0, 0, 0); // Set to 9 AM
        etaField.value = inThreeDays.toISOString().slice(0, 16);
    }
    
    // Set Bayan date to current date
    const bayanDateField = document.getElementById('bayanDate');
    if (bayanDateField) {
        bayanDateField.value = now.toISOString().split('T')[0];
    }
}

// Enhanced autocomplete setup with proper dropdown positioning
function setupEnhancedAutocomplete() {
    // Customer name suggestions
    const customerNameField = document.getElementById('customerName');
    if (customerNameField) {
        setupEnhancedCustomerAutocomplete(customerNameField);
    }
    
    // Requester name suggestions
    const requesterField = document.getElementById('requesterName');
    if (requesterField) {
        setupEnhancedRequesterAutocomplete(requesterField);
    }
    
    // Port of arrival - Use normal dropdown
    const portField = document.getElementById('portArrival');
    if (portField) {
        // Make it a simple dropdown, not autocomplete
        createPortDropdown(portField);
    }
    
    // Shipper name suggestions
    const shipperField = document.getElementById('shipperName');
    if (shipperField) {
        setupEnhancedShipperAutocomplete(shipperField);
    }
    
    // Cost Center - Use normal dropdown
    const costCenterField = document.getElementById('costCenter');
    if (costCenterField) {
        // Make it a simple dropdown, not autocomplete
        createCostCenterDropdown(costCenterField);
    }
}

// Update both createPortDropdown and createCostCenterDropdown functions
function createPortDropdown(inputField) {
    // Check if dropdown already exists and remove it
    const existingSelect = document.getElementById(inputField.id + '-select');
    const existingWrapper = inputField.nextElementSibling;
    
    if (existingSelect) {
        existingSelect.remove();
    }
    if (existingWrapper && existingWrapper.classList.contains('dropdown-wrapper')) {
        existingWrapper.remove();
    }
    
    // First, remove the required attribute from the hidden input
    // We'll make the select element required instead
    inputField.removeAttribute('required');
    
    // Hide the original input field
    inputField.style.display = 'none';
    
    // Create a simple select dropdown
    const select = document.createElement('select');
    select.className = 'form-control normal-dropdown';
    select.name = inputField.name + '-dropdown'; // Use different name to avoid conflict
    select.id = inputField.id + '-select';
    select.required = true; // Make select required instead
    
    // Add placeholder option
    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = 'Select Port of Arrival';
    placeholderOption.disabled = true;
    placeholderOption.selected = true;
    select.appendChild(placeholderOption);
    
    // Add port options
    const ports = [
        "Jebel Ali Port, UAE",
        "Khalifa Port, UAE",
        "Hamad Port, Qatar",
        "Kuwait Port, Kuwait",
        "Shuwaikh Port, Kuwait",
        "King Abdulaziz Port, Saudi Arabia",
        "Jeddah Islamic Port, Saudi Arabia",
        "Port of Salalah, Oman",
        "Port of Bahrain, Bahrain",
        "Port of Singapore, Singapore",
        "Port Klang, Malaysia",
        "Port of Colombo, Sri Lanka",
        "Port of Karachi, Pakistan",
        "Nhava Sheva Port, India",
        "Chittagong Port, Bangladesh",
        "Port of Hong Kong, China",
        "Port of Shanghai, China",
        "Port of Busan, South Korea",
        "Port of Tokyo, Japan",
        "Port of Rotterdam, Netherlands",
        "Port of Hamburg, Germany",
        "Port of Antwerp, Belgium",
        "Port of Felixstowe, UK",
        "Port of Le Havre, France"
    ];
    
    // Add options to dropdown
    ports.forEach(port => {
        const option = document.createElement('option');
        option.value = port;
        option.textContent = port;
        select.appendChild(option);
    });
    
    // Set initial value if exists
    if (inputField.value) {
        select.value = inputField.value;
    }
    
    // Insert dropdown after input field
    const wrapper = document.createElement('div');
    wrapper.className = 'dropdown-wrapper';
    inputField.parentNode.insertBefore(wrapper, inputField.nextSibling);
    wrapper.appendChild(select);
    
    // Update hidden input when dropdown changes
    select.addEventListener('change', function() {
        inputField.value = this.value;
        // Trigger input event for preview
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
    });
    
    // Also trigger change on the select for validation
    select.addEventListener('change', function() {
        // Trigger validation check
        this.reportValidity();
    });
    
    // Set focusable tabindex
    select.tabIndex = inputField.tabIndex;
}

function createCostCenterDropdown(inputField) {
    // Check if dropdown already exists and remove it
    const existingSelect = document.getElementById(inputField.id + '-select');
    const existingWrapper = inputField.nextElementSibling;
    
    if (existingSelect) {
        existingSelect.remove();
    }
    if (existingWrapper && existingWrapper.classList.contains('dropdown-wrapper')) {
        existingWrapper.remove();
    }
    
    // First, remove the required attribute from the hidden input
    // We'll make the select element required instead
    inputField.removeAttribute('required');
    
    // Hide the original input field
    inputField.style.display = 'none';
    
    // Create a simple select dropdown
    const select = document.createElement('select');
    select.className = 'form-control normal-dropdown';
    select.name = inputField.name + '-dropdown'; // Use different name to avoid conflict
    select.id = inputField.id + '-select';
    select.required = true; // Make select required instead
    
    // Add placeholder option
    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = 'Select Cost Center';
    placeholderOption.disabled = true;
    placeholderOption.selected = true;
    select.appendChild(placeholderOption);
    
    // Add cost center options
    const costCenters = [
        "UAE - Abu Dhabi",
        "UAE - Dubai",
        "UAE - Sharjah",
        "UAE - Ajman",
        "UAE - Umm Al-Quwain",
        "UAE - Ras Al Khaimah",
        "UAE - Fujairah",
        "Saudi Arabia - Riyadh",
        "Saudi Arabia - Jeddah",
        "Saudi Arabia - Dammam",
        "Saudi Arabia - Khobar",
        "Kuwait - Kuwait City",
        "Kuwait - Ahmadi",
        "Kuwait - Hawalli",
        "Qatar - Doha",
        "Qatar - Al Rayyan",
        "Bahrain - Manama",
        "Oman - Muscat",
        "Oman - Salalah",
        "International - UK",
        "International - USA",
        "International - Europe",
        "International - Asia Pacific",
        "Head Office - Kuwait"
    ];
    
    // Add options to dropdown
    costCenters.forEach(center => {
        const option = document.createElement('option');
        option.value = center;
        option.textContent = center;
        select.appendChild(option);
    });
    
    // Set initial value if exists
    if (inputField.value) {
        select.value = inputField.value;
    }
    
    // Insert dropdown after input field
    const wrapper = document.createElement('div');
    wrapper.className = 'dropdown-wrapper';
    inputField.parentNode.insertBefore(wrapper, inputField.nextSibling);
    wrapper.appendChild(select);
    
    // Update hidden input when dropdown changes
    select.addEventListener('change', function() {
        inputField.value = this.value;
        // Trigger input event for preview
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
    });
    
    // Also trigger change on the select for validation
    select.addEventListener('change', function() {
        // Trigger validation check
        this.reportValidity();
    });
    
    // Set focusable tabindex
    select.tabIndex = inputField.tabIndex;
}

function setupEnhancedCustomerAutocomplete(inputField) {
    let timeout;
    let dropdown = null;
    let selectedIndex = -1;
    let currentSuggestions = [];
    
    function showDropdown(suggestions) {
        removeDropdown();
        currentSuggestions = suggestions;
        
        if (!suggestions || suggestions.length === 0) return;
        
        dropdown = document.createElement('div');
        dropdown.className = 'autocomplete-dropdown enhanced-dropdown';
        dropdown.style.width = inputField.offsetWidth + 'px';
        dropdown.style.position = 'absolute';
        dropdown.style.zIndex = '1000';
        
        // Create search header
        const searchHeader = document.createElement('div');
        searchHeader.className = 'dropdown-search-header';
        searchHeader.innerHTML = `
            <i class="fas fa-search"></i>
            <input type="text" class="dropdown-search-input" placeholder="Search customers...">
        `;
        dropdown.appendChild(searchHeader);
        
        // Create suggestions container
        const suggestionsContainer = document.createElement('div');
        suggestionsContainer.className = 'dropdown-suggestions';
        
        suggestions.forEach((customer, index) => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.dataset.index = index;
            item.innerHTML = `
                <div class="item-main">
                    <strong>${customer.name}</strong>
                    <span class="item-badge">${customer.company || 'No Company'}</span>
                </div>
                <div class="item-details">
                    <small><i class="fas fa-envelope"></i> ${customer.email || 'No email'}</small>
                    <small><i class="fas fa-phone"></i> ${customer.phone || 'No phone'}</small>
                </div>
            `;
            
            item.addEventListener('click', () => {
                selectCustomer(customer, inputField);
                removeDropdown();
            });
            
            item.addEventListener('mouseenter', () => {
                highlightItem(index);
            });
            
            suggestionsContainer.appendChild(item);
        });
        
        dropdown.appendChild(suggestionsContainer);
        
        // Position dropdown below input field
        positionDropdown(dropdown, inputField);
        
        document.body.appendChild(dropdown);
        
        // Setup search in dropdown
        const searchInput = dropdown.querySelector('.dropdown-search-input');
        if (searchInput) {
            searchInput.focus();
            searchInput.addEventListener('input', function (e) {
                filterDropdownSuggestions(e.target.value);
                selectedIndex = -1;
                highlightVisibleItem(-1);
            });
            searchInput.addEventListener('keydown', handleDropdownNavigation);
        }
        
        // Handle click outside
        document.addEventListener('click', handleClickOutside);
    }
    
    function filterDropdownSuggestions(searchTerm) {
        const items = dropdown.querySelectorAll('.autocomplete-item');
        items.forEach(item => {
            const text = item.textContent.toLowerCase();
            item.style.display = text.includes(searchTerm.toLowerCase()) ? '' : 'none';
        });
    }
    
    function highlightItem(index) {
        const items = dropdown.querySelectorAll('.autocomplete-item');
        items.forEach((item, i) => {
            item.classList.toggle('highlighted', i === index);
        });
        selectedIndex = index;
    }

    function highlightVisibleItem(index) {
        if (!dropdown) return;

        const items = Array.from(
            dropdown.querySelectorAll('.autocomplete-item')
        ).filter(el => el.style.display !== 'none');

        items.forEach((item, i) => {
            item.classList.toggle('highlighted', i === index);
        });
    }
    
    function handleDropdownNavigation(e) {
        if (!dropdown) return;

        const items = Array.from(
            dropdown.querySelectorAll('.autocomplete-item')
        ).filter(el => el.style.display !== 'none');

        if (!items.length) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = (selectedIndex + 1) % items.length;
            highlightVisibleItem(selectedIndex);
            items[selectedIndex].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
            highlightVisibleItem(selectedIndex);
            items[selectedIndex].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            items[selectedIndex].click();
        } else if (e.key === 'Escape') {
            removeDropdown();
        }
    }
    
    function handleClickOutside(e) {
        if (dropdown && !dropdown.contains(e.target) && e.target !== inputField) {
            removeDropdown();
        }
    }
    
    function selectCustomer(customer, inputField) {
        // Fill customer details
        inputField.value = customer.name;
        
        // Auto-fill other customer fields
        const customerRefNo = document.getElementById('customerRefNo');
        const customerAddress = document.getElementById('customerAddress');
        const email = document.getElementById('email');
        const phone = document.getElementById('phone');
        
        if (customerRefNo) customerRefNo.value = customer.reference_number || '';
        if (customerAddress) {
            customerAddress.value = customer.address || '';
            markAutoFilled(customerAddress);
        }
        if (email) {
            email.value = customer.email || '';
            markAutoFilled(email);
        }
        if (phone) {
            phone.value = customer.phone || '';
            markAutoFilled(phone);
        }
    }
    
    inputField.addEventListener('input', function(e) {
        clearTimeout(timeout);
        const query = e.target.value.trim();
        
        if (query.length < 2) {
            removeDropdown();
            return;
        }
        
        timeout = setTimeout(async () => {
            try {
                const response = await fetch(`https://powerpoint-fruit-valves-succeed.trycloudflare.com/api/customers/search?q=${encodeURIComponent(query)}`);
                if (response.ok) {
                    const customers = await response.json();
                    showDropdown(customers);
                }
            } catch (error) {
                console.error('Error fetching customers:', error);
            }
        }, 300);
    });
    
    inputField.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' && dropdown) {
            e.preventDefault();
            const items = Array.from(
                dropdown.querySelectorAll('.autocomplete-item')
            ).filter(el => el.style.display !== 'none');
            if (!items.length) return;
            selectedIndex = 0;
            highlightVisibleItem(selectedIndex);
            items[0].scrollIntoView({ block: 'nearest' });
        }
    });
}

function setupEnhancedShipperAutocomplete(inputField) {
    let timeout;
    let dropdown;
    let currentSuggestions = [];
    
    inputField.addEventListener('input', function(e) {
        clearTimeout(timeout);
        const query = e.target.value.trim();
        
        if (query.length < 2) {
            removeDropdown();
            return;
        }
        
        timeout = setTimeout(async () => {
            try {
                const response = await fetch(`https://powerpoint-fruit-valves-succeed.trycloudflare.com/api/shippers/search?q=${encodeURIComponent(query)}`);
                if (response.ok) {
                    const shippers = await response.json();
                    currentSuggestions = shippers;
                    showEnhancedShipperDropdown(shippers, inputField);
                }
            } catch (error) {
                console.error('Error fetching shippers:', error);
            }
        }, 300);
    });
    
    function showEnhancedShipperDropdown(shippers, inputField) {
        removeDropdown();
        
        if (shippers.length === 0) return;
        
        dropdown = document.createElement('div');
        dropdown.className = 'autocomplete-dropdown enhanced-dropdown shipper-dropdown';
        dropdown.style.width = inputField.offsetWidth + 'px';
        dropdown.style.position = 'absolute';
        dropdown.style.zIndex = '1000';
        
        // Position dropdown
        positionDropdown(dropdown, inputField);
        
        shippers.forEach((shipper, index) => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.dataset.index = index;
            item.innerHTML = `
                <div class="item-main">
                    <strong>${shipper.name}</strong>
                    <span class="item-badge">${shipper.country || 'Unknown'}</span>
                </div>
                <div class="item-details">
                    <small><i class="fas fa-file-contract"></i> Ref: ${shipper.reference_number || 'No ref'}</small>
                    <small><i class="fas fa-building"></i> ${shipper.company || 'No company'}</small>
                </div>
            `;
            item.addEventListener('click', () => {
                selectEnhancedShipper(shipper, inputField);
                removeDropdown();
            });
            dropdown.appendChild(item);
        });
        
        document.body.appendChild(dropdown);
        
        // Handle click outside
        document.addEventListener('click', function(e) {
            if (dropdown && !dropdown.contains(e.target) && e.target !== inputField) {
                removeDropdown();
            }
        });
    }
    
    function selectEnhancedShipper(shipper, inputField) {
        inputField.value = shipper.name;
        
        // Auto-fill shipper reference number and make it read-only
        const shipperRefNoField = document.getElementById('shipperRefNo');
        if (shipperRefNoField) {
            shipperRefNoField.value = shipper.reference_number || '';
            shipperRefNoField.classList.add('auto-filled');
            shipperRefNoField.readOnly = true;
            
            // Add edit button
            addEditButton(shipperRefNoField);
        }
    }
}

// Enhanced requester autocomplete
function setupEnhancedRequesterAutocomplete(inputField) {
    let timeout;
    let dropdown;
    
    inputField.addEventListener('input', function(e) {
        clearTimeout(timeout);
        const query = e.target.value.trim();
        
        if (query.length < 2) {
            removeDropdown();
            return;
        }
        
        timeout = setTimeout(async () => {
            try {
                const response = await fetch(`https://powerpoint-fruit-valves-succeed.trycloudflare.com/api/requesters/search?q=${encodeURIComponent(query)}`);
                if (response.ok) {
                    const requesters = await response.json();
                    showEnhancedRequesterDropdown(requesters, inputField);
                }
            } catch (error) {
                console.error('Error fetching requesters:', error);
            }
        }, 300);
    });
    
    function showEnhancedRequesterDropdown(requesters, inputField) {
        removeDropdown();
        
        if (requesters.length === 0) return;
        
        dropdown = document.createElement('div');
        dropdown.className = 'autocomplete-dropdown enhanced-dropdown';
        dropdown.style.width = inputField.offsetWidth + 'px';
        dropdown.style.position = 'absolute';
        dropdown.style.zIndex = '1000';
        
        // Position dropdown
        positionDropdown(dropdown, inputField);
        
        requesters.forEach(requester => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.innerHTML = `
                <div class="item-main">
                    <strong>${requester.name}</strong>
                    <span class="item-badge">${requester.department || 'No Dept'}</span>
                </div>
                <div class="item-details">
                    <small><i class="fas fa-building"></i> ${requester.company || 'No company'}</small>
                </div>
            `;
            item.addEventListener('click', () => {
                inputField.value = requester.name;
                removeDropdown();
            });
            dropdown.appendChild(item);
        });
        
        document.body.appendChild(dropdown);
        
        // Handle click outside
        document.addEventListener('click', function(e) {
            if (dropdown && !dropdown.contains(e.target) && e.target !== inputField) {
                removeDropdown();
            }
        });
    }
}

function removeDropdown() {
    const existing = document.querySelector('.autocomplete-dropdown');
    if (existing) {
        existing.remove();
    }
}

function positionDropdown(dropdown, inputField) {
    const rect = inputField.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + window.scrollY + 2) + 'px';
    dropdown.style.left = (rect.left + window.scrollX) + 'px';
    dropdown.style.width = inputField.offsetWidth + 'px';
}

function markAutoFilled(field) {
    if (field) {
        field.classList.add('auto-filled');
        field.readOnly = true;
        
        // Add edit button
        addEditButton(field);
    }
}

function addEditButton(field) {
    // Remove existing edit button if any
    const existingBtn = field.parentNode.querySelector('.edit-auto-filled');
    if (existingBtn) existingBtn.remove();
    
    // Only add edit button if field is not job number (job number should be permanent after save)
    if (field.id === 'jobNo') {
        return;
    }
    
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'edit-auto-filled';
    editBtn.innerHTML = '<i class="fas fa-edit"></i>';
    editBtn.title = 'Edit this field';
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        field.classList.remove('auto-filled');
        field.readOnly = false;
        field.focus();
        editBtn.remove();
    });
    
    field.parentNode.style.position = 'relative';
    field.parentNode.appendChild(editBtn);
}

function setupEditButtons() {
    // Add edit buttons to auto-filled fields
    const autoFillableFields = [
        'customerAddress',
        'email',
        'phone',
        'shipperRefNo'
    ];
    
    autoFillableFields.forEach(fieldId => {
        const field = document.getElementById(fieldId);
        if (field) {
            field.addEventListener('focus', function() {
                if (this.classList.contains('auto-filled')) {
                    this.classList.remove('auto-filled');
                    this.readOnly = false;
                    const editBtn = this.parentNode.querySelector('.edit-auto-filled');
                    if (editBtn) editBtn.remove();
                }
            });
        }
    });
}

// function setupRealTimePreview() {
//     const inputs = document.querySelectorAll('#jobCardForm input, #jobCardForm select, #jobCardForm textarea');
    
//     inputs.forEach(input => {
//         input.addEventListener('input', updatePreview);
//         input.addEventListener('change', updatePreview);
//     });
// }

function setupRealTimePreview() {
    // Don't auto-update modal preview constantly
    // We'll update it when modal opens
}

function updatePreview() {
    const previewDiv = document.getElementById('jobCardPreview');
    
    // IMPORTANT: Read from the original input fields (which are hidden but have values)
    const formData = {
        jobNo: document.getElementById('jobNo')?.value || 'Not Set',
        date: document.getElementById('date')?.value || 'Not Set',
        modeOfTravel: document.getElementById('modeOfTravel')?.value || 'Not Set',
        shipmentType: document.getElementById('shipmentType')?.value || 'Not Set',
        costCenter: document.getElementById('costCenter')?.value || 'Not Set', // This reads from hidden input
        bayanNo: document.getElementById('bayanNo')?.value || 'Not Set',
        bayanDate: document.getElementById('bayanDate')?.value || 'Not Set',
        grossWeight: document.getElementById('grossWeight')?.value || '0',
        packages: document.getElementById('packages')?.value || '0',
        packageType: document.getElementById('packageType')?.value || 'Not Set',
        customerName: document.getElementById('customerName')?.value || 'Not Set',
        customerRefNo: document.getElementById('customerRefNo')?.value || 'Not Set',
        email: document.getElementById('email')?.value || 'Not Set',
        phone: document.getElementById('phone')?.value || 'Not Set',
        customerAddress: document.getElementById('customerAddress')?.value || 'Not Set',
        requesterName: document.getElementById('requesterName')?.value || 'Not Set',
        shipperName: document.getElementById('shipperName')?.value || 'Not Set',
        truckWaybillNo: document.getElementById('truckWaybillNo')?.value || 'Not Set',
        portArrival: document.getElementById('portArrival')?.value || 'Not Set', // This reads from hidden input
        estd: document.getElementById('estd')?.value || 'Not Set',
        eta: document.getElementById('eta')?.value || 'Not Set',
        shipperRefNo: document.getElementById('shipperRefNo')?.value || 'Not Set',
        description: document.getElementById('description')?.value || 'Not Set',
        specialInstructions: document.getElementById('specialInstructions')?.value || 'Not Set',
        dimensions: document.getElementById('dimensions')?.value || 'Not Set'
    };
    
    // Format shipment type for display
    let shipmentTypeDisplay = formData.shipmentType;
    switch(formData.shipmentType) {
        case 'I': shipmentTypeDisplay = 'Import'; break;
        case 'E': shipmentTypeDisplay = 'Export'; break;
        case 'D': shipmentTypeDisplay = 'Domestic'; break;
    }
    
    // Format mode of travel for display
    let modeDisplay = formData.modeOfTravel;
    switch(formData.modeOfTravel) {
        case 'ROA': modeDisplay = 'Road'; break;
        case 'AIR': modeDisplay = 'Air'; break;
        case 'SEA': modeDisplay = 'Sea'; break;
        case 'MUL': modeDisplay = 'Multimodal'; break;
    }
    
    const allEmpty = Object.values(formData).every(value => 
        value === 'Not Set' || value === '0' || value === ''
    );
    
    if (allEmpty) {
        previewDiv.innerHTML = `
            <div class="preview-placeholder">
                <i class="fas fa-clipboard-list"></i>
                <p>Fill the form to see preview</p>
            </div>
        `;
        return;
    }
    
    previewDiv.innerHTML = `
        <div class="preview-content">
            <div class="preview-card">
                <div class="preview-section">
                    <h4>REFERENCE DETAILS</h4>
                    <div class="preview-item">
                        <span class="preview-label">JOB NUMBER</span>
                        <span class="preview-value">${formData.jobNo}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">OPERATIONAL DATE</span>
                        <span class="preview-value">${formatDate(formData.date)}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">COST CENTER</span>
                        <span class="preview-value">${formData.costCenter}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">MODE OF TRAVEL</span>
                        <span class="preview-value">${modeDisplay}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">SHIPMENT TYPE</span>
                        <span class="preview-value">${shipmentTypeDisplay}</span>
                    </div>
                </div>
            </div>
            
            <div class="preview-card">
                <div class="preview-section">
                    <h4>CARGO SPECS</h4>
                    <div class="preview-item">
                        <span class="preview-label">BAYAN NUMBER</span>
                        <span class="preview-value">${formData.bayanNo}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">GROSS WEIGHT</span>
                        <span class="preview-value">${formData.grossWeight} kg</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">PACKAGES</span>
                        <span class="preview-value">${formData.packages} ${formData.packageType}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">BAYAN DATE</span>
                        <span class="preview-value">${formatDate(formData.bayanDate)}</span>
                    </div>
                </div>
            </div>
            
            <div class="preview-card">
                <div class="preview-section">
                    <h4>CLIENT INFORMATION</h4>
                    <div class="preview-item">
                        <span class="preview-label">CUSTOMER NAME</span>
                        <span class="preview-value">${formData.customerName}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">CUSTOMER REF #</span>
                        <span class="preview-value">${formData.customerRefNo}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">CONTACT EMAIL</span>
                        <span class="preview-value">${formData.email}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">PHONE</span>
                        <span class="preview-value">${formData.phone}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">ADDRESS</span>
                        <span class="preview-value">${formData.customerAddress.substring(0, 80)}${formData.customerAddress.length > 80 ? '...' : ''}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">REQUESTER NAME</span>
                        <span class="preview-value">${formData.requesterName}</span>
                    </div>
                </div>
            </div>
            
            <div class="preview-card">
                <div class="preview-section">
                    <h4>LOGISTICS PATH</h4>
                    <div class="preview-item">
                        <span class="preview-label">SHIPPER / VENDOR</span>
                        <span class="preview-value">${formData.shipperName}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">WAYBILL / TRUCK NO</span>
                        <span class="preview-value">${formData.truckWaybillNo}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">PORT OF ARRIVAL</span>
                        <span class="preview-value">${formData.portArrival}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">ESTD</span>
                        <span class="preview-value">${formatDateTime(formData.estd)}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">ETA</span>
                        <span class="preview-value">${formatDateTime(formData.eta)}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">SHIPPER REF NO</span>
                        <span class="preview-value">${formData.shipperRefNo}</span>
                    </div>
                </div>
            </div>
            
            <div class="preview-card wide">
                <div class="preview-section">
                    <h4>CARGO DESCRIPTION & INSTRUCTIONS</h4>
                    <div class="preview-item">
                        <span class="preview-label">DESCRIPTION OF GOODS</span>
                        <span class="preview-value">${formData.description.substring(0, 200)}${formData.description.length > 200 ? '...' : ''}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">SPECIAL INSTRUCTIONS</span>
                        <span class="preview-value">${formData.specialInstructions.substring(0, 150)}${formData.specialInstructions.length > 150 ? '...' : ''}</span>
                    </div>
                    <div class="preview-item">
                        <span class="preview-label">DIMENSIONS</span>
                        <span class="preview-value">${formData.dimensions}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function formatDate(dateString) {
    if (!dateString || dateString === 'Not Set') return 'Not Set';
    
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    } catch (e) {
        return dateString;
    }
}

function showPreviewModal() {
    // First validate the form
    const form = document.getElementById('jobCardForm');
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }
    
    // Update the preview
    updatePreview();
    
    // Show the modal
    const modal = document.getElementById('previewModal');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closePreviewModal() {
    const modal = document.getElementById('previewModal');
    modal.classList.remove('active');
    document.body.style.overflow = 'auto';
}

function showSuccessModal(jobNumber, invoiceNumber) {
    document.getElementById('savedJobNumber').textContent = jobNumber;
    if (invoiceNumber) {
        document.getElementById('generatedInvoice').textContent = invoiceNumber;
    }
    
    const modal = document.getElementById('successModal');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    // NEW: Auto-close and reset form after 5 seconds
    setTimeout(() => {
        closeSuccessModal();
    }, 5000); // 5000 milliseconds = 5 seconds
}


function closeSuccessModal() {
    const modal = document.getElementById('successModal');
    modal.classList.remove('active');
    document.body.style.overflow = 'auto';
    
    // Reset form for new entry
    resetForm();
}

// Update print function
function printJobCard() {
    window.print();
}

async function saveJobCard() {
    const form = document.getElementById('jobCardForm');

    syncDropdownValuesToForm();

    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }
    
    const jobNoField = document.getElementById('jobNo');
    const modeSelect = document.getElementById('modeOfTravel');
    const typeSelect = document.getElementById('shipmentType');
    
    // Validate job number format
    const jobNoPattern = /^(ROA|AIR|SEA|MUL|JC)-[IED]-20\d{2}-\d{6}$/;
    if (!jobNoPattern.test(jobNoField.value)) {
        showNotification('Invalid job number format. Expected format: AIR-E-2026-000001', 'error');
        jobNoField.focus();
        return;
    }
    
    // Check if mode and type are selected
    if (!modeSelect.value || !typeSelect.value) {
        showNotification('Please select Mode of Travel and Shipment Type.', 'error');
        return;
    }
    
    if (!jobNoField.value) {
        // If job number not generated, generate one first
        await fetchNextJobNumber();
        if (!jobNoField.value) {
            showNotification('Please wait for job number generation.', 'error');
            return;
        }
    }
    
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    
    // Add metadata
    data.status = 'draft';
    data.createdAt = new Date().toISOString();
    data.createdBy = document.getElementById('userName')?.textContent || 'Unknown';
    
    const submitBtn = document.querySelector('button[onclick="saveJobCard()"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    submitBtn.disabled = true;
    
    try {
        const response = await fetch('https://powerpoint-fruit-valves-succeed.trycloudflare.com/api/jobcards/save-draft', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            const result = await response.json();
            
            // If backend returns a new job number, update it
            if (result.jobNumber && result.jobNumber !== jobNoField.value) {
                jobNoField.value = result.jobNumber;
            }
            
            // Store job card ID for later submission
            window.currentJobCardId = result.id;
            
            // Make job number read-only after saving
            jobNoField.readOnly = true;
            jobNoField.classList.add('auto-filled');
            
            // Add edit button
            addEditButton(jobNoField);
            
            // Close preview modal if open
            closePreviewModal();
            
            // Show success modal with job number and invoice number
            showSuccessModal(jobNoField.value, result.invoiceNumber);
            
        } else {
            throw new Error('Failed to save draft');
        }
    } catch (error) {
        showNotification('Error saving draft: ' + error.message, 'error');
    } finally {
        submitBtn.innerHTML = originalText;
        submitBtn.disabled = false;
    }
}


// Add this helper function to sync dropdown values
function syncDropdownValuesToForm() {
    // Sync port arrival dropdown
    const portSelect = document.getElementById('portArrival-select');
    const portInput = document.getElementById('portArrival');
    if (portSelect && portInput) {
        portInput.value = portSelect.value;
    }
    
    // Sync cost center dropdown
    const costCenterSelect = document.getElementById('costCenter-select');
    const costCenterInput = document.getElementById('costCenter');
    if (costCenterSelect && costCenterInput) {
        costCenterInput.value = costCenterSelect.value;
    }
}

async function handleJobCardSubmit(event) {
    event.preventDefault();
    
    const form = event.target;
    syncDropdownValuesToForm();

    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }
    
    const jobNoField = document.getElementById('jobNo');
    
    // Validate job number format
    const jobNoPattern = /^(ROA|AIR|SEA|MUL|JC)-[IED]-20\d{2}-\d{6}$/;
    if (!jobNoPattern.test(jobNoField.value)) {
        showNotification('Invalid job number format. Expected format: AIR-E-2026-000001', 'error');
        jobNoField.focus();
        return;
    }
    
    // Check if job number already exists (only for new entries)
    if (!window.currentJobCardId) {
        const exists = await checkJobNumberExists(jobNoField.value);
        if (exists) {
            showNotification('Job number already exists. Please use a different number.', 'error');
            jobNoField.focus();
            return;
        }
    }
    
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    
    // Add metadata
    data.status = 'submitted';
    data.submittedAt = new Date().toISOString();
    data.submittedBy = document.getElementById('userName')?.textContent || 'Unknown';
    
    // Use existing draft ID or create new
    if (window.currentJobCardId) {
        data.id = window.currentJobCardId;
    }
    
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
    submitBtn.disabled = true;
    
    try {
        const response = await fetch('https://powerpoint-fruit-valves-succeed.trycloudflare.com/api/jobcards/submit', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            const result = await response.json();
            
            // Make job number permanently read-only
            jobNoField.readOnly = true;
            jobNoField.classList.add('auto-filled');
            
            // Remove edit button
            const editBtn = jobNoField.parentNode.querySelector('.edit-auto-filled');
            if (editBtn) editBtn.remove();
            
            // Show success widget
            showSuccessWidget(result.jobNumber);
            
            // Reset form for new entry after delay
            setTimeout(() => {
                form.reset();
                window.currentJobCardId = null;
                
                // Generate new job number for next entry
                generateJobNumber();
                initializeDates();
                updatePreview();
                updateStats();
            }, 3000);
        } else {
            const error = await response.json();
            showNotification('Error submitting job card: ' + (error.message || 'Unknown error'), 'error');
            throw new Error('Submission failed');
        }
    } catch (error) {
        showNotification('Error submitting job card: ' + error.message, 'error');
    } finally {
        submitBtn.innerHTML = originalText;
        submitBtn.disabled = false;
    }
}

function showErrorWidget(message = 'Submission failed') {
    // Remove existing widget
    const existing = document.querySelector('.modern-notification-widget');
    if (existing) {
        existing.remove();
    }
    
    // Create modern error widget
    const widget = document.createElement('div');
    widget.className = 'modern-notification-widget error';
    widget.innerHTML = `
        <div class="modern-widget-content">
            <div class="modern-widget-icon">
                <i class="fas fa-exclamation-circle"></i>
            </div>
            <div class="modern-widget-details">
                <h3>ERROR!</h3>
                <p>Thank you for your request.</p>
                <p>We are unable to continue the process.</p>
                <p>${message}</p>
                <div class="modern-widget-actions">
                    <button onclick="closeModernWidget()" class="modern-btn modern-btn-primary">
                        Try Again
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(widget);
}

function resetForm() {
    if (confirm('Are you sure you want to reset the form? All entered data will be lost.')) {
        const form = document.getElementById('jobCardForm');
        const jobNoField = document.getElementById('jobNo');
        const modeSelect = document.getElementById('modeOfTravel');
        const typeSelect = document.getElementById('shipmentType');
        
        // Store current values
        const currentJobNo = jobNoField.value;
        const currentMode = modeSelect ? modeSelect.value : '';
        const currentType = typeSelect ? typeSelect.value : '';
        
        form.reset();
        window.currentJobCardId = null;
        
        // Reset mode and type to empty
        if (modeSelect) modeSelect.value = '';
        if (typeSelect) typeSelect.value = '';
        
        // Keep the job number if it's already set, but clear if mode/type changed
        if (currentJobNo && currentMode && currentType) {
            jobNoField.value = currentJobNo;
            jobNoField.readOnly = false;
            jobNoField.classList.remove('auto-filled');
        } else {
            // Clear job number
            jobNoField.value = '';
        }
        
        initializeDates();
        updatePreview();
        showNotification('Form has been reset', 'info');
    }
}



async function generateInvoice() {
    const form = document.getElementById('jobCardForm');
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }
    
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    
    // Validate required fields
    const requiredFields = ['jobNo', 'customerName', 'customerRefNo', 'grossWeight', 'packages'];
    const missingFields = requiredFields.filter(field => !data[field]);
    
    if (missingFields.length > 0) {
        showNotification('Please fill all required fields before generating invoice.', 'error');
        return;
    }
    
    // First save as draft if not saved
    if (!window.currentJobCardId) {
        await saveJobCard();
        if (!window.currentJobCardId) {
            showNotification('Please save the job card first.', 'error');
            return;
        }
    }
    
    // Generate invoice from job card
    try {
        const response = await fetch('https://powerpoint-fruit-valves-succeed.trycloudflare.com/api/jobcards/generate-invoice', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jobCardId: window.currentJobCardId,
                jobCardData: data
            })
        });
        
        if (response.ok) {
            const result = await response.json();
            
            // Store invoice data and redirect
            sessionStorage.setItem('currentJobCard', JSON.stringify(data));
            sessionStorage.setItem('invoiceData', JSON.stringify(result));
            
            // Redirect to invoice generator
            window.location.href = 'invoice-generator.html';
        } else {
            throw new Error('Failed to generate invoice');
        }
    } catch (error) {
        showNotification('Error generating invoice: ' + error.message, 'error');
    }
}

function showSuccessWidget(jobNumber) {
    // Remove existing widget
    const existing = document.querySelector('.modern-notification-widget');
    if (existing) {
        existing.remove();
    }
    
    // Create modern success widget
    const widget = document.createElement('div');
    widget.className = 'modern-notification-widget success';
    widget.innerHTML = `
        <div class="modern-widget-content">
            <div class="modern-widget-icon">
                <i class="fas fa-check-circle"></i>
            </div>
            <div class="modern-widget-details">
                <h3>SUCCESS</h3>
                <p>Thank you for your request.</p>
                <p>We are working hard to find the best service and deals for you.</p>
                <p>Shortly you will find a confirmation in your email.</p>
                <div class="modern-widget-actions">
                    <button onclick="closeModernWidget()" class="modern-btn modern-btn-primary">
                        Continue
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(widget);
    
    // Auto-hide after 8 seconds
    setTimeout(() => {
        if (widget.parentNode) {
            closeModernWidget();
        }
    }, 8000);
}


function printJobCard(jobNumber) {
    // Implement print functionality
    window.print();
}

        async function generateInvoiceFromSuccess(jobNumber) {
            try {
                const response = await fetch(`https://powerpoint-fruit-valves-succeed.trycloudflare.com/api/jobcards/${jobNumber}/invoice`);
                if (response.ok) {
                    const result = await response.json();
                    sessionStorage.setItem('invoiceData', JSON.stringify(result));
                    window.location.href = 'invoice-generator.html';
                }
            } catch (error) {
                showNotification('Error generating invoice: ' + error.message, 'error');
            }
        }

            function closeModernWidget() {
        const widget = document.querySelector('.modern-notification-widget');
        if (widget) {
            widget.style.animation = 'slideOutRight 0.3s ease';
            setTimeout(() => {
                if (widget.parentNode) {
                    widget.remove();
                }
            }, 300);
        }
    }

        function showNotification(message, type = 'info') {
            // Remove existing notification
            const existing = document.querySelector('.modern-notification-widget');
            if (existing) {
                existing.remove();
            }
            
            let title, icon, btnText;
            
            if (type === 'success') {
                title = 'SUCCESS';
                icon = 'fa-check-circle';
                btnText = 'Continue';
            } else if (type === 'error') {
                title = 'ERROR!';
                icon = 'fa-exclamation-circle';
                btnText = 'Try Again';
            } else {
                title = 'INFO';
                icon = 'fa-info-circle';
                btnText = 'OK';
            }
            
            // Create modern notification widget
            const widget = document.createElement('div');
            widget.className = `modern-notification-widget ${type}`;
            widget.innerHTML = `
                <div class="modern-widget-content">
                    <div class="modern-widget-icon">
                        <i class="fas ${icon}"></i>
                    </div>
                    <div class="modern-widget-details">
                        <h3>${title}</h3>
                        <p>${message}</p>
                        <div class="modern-widget-actions">
                            <button onclick="closeModernWidget()" class="modern-btn modern-btn-primary">
                                ${btnText}
                            </button>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.appendChild(widget);
            
            // Auto-hide after 8 seconds for success/info, 10 seconds for error
            const autoHideTime = type === 'error' ? 10000 : 8000;
            setTimeout(() => {
                if (widget.parentNode) {
                    closeModernWidget();
                }
            }, autoHideTime);
        }

function updateSystemTime() {
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

async function updateStats() {
    try {
        const response = await fetch('https://powerpoint-fruit-valves-succeed.trycloudflare.com/api/stats/jobcards');
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

function addEnhancedStyles() {
    if (!document.querySelector('#enhanced-autocomplete-styles')) {
        const style = document.createElement('style');
        style.id = 'enhanced-autocomplete-styles';
        style.textContent = `
            /* GLOBAL CSS VARIABLES */
            :root {
                --bg-body: #f3f4f6;
                --bg-card: #ffffff;
                --bg-muted: #f9fafb;
                --primary: #2563eb;
                --primary-soft: rgba(37, 99, 235, 0.12);
                --primary-dark: #1d4ed8;
                --accent: #10b981;
                --accent-soft: rgba(16, 185, 129, 0.14);
                --border-subtle: #e5e7eb;
                --border-strong: #d1d5db;
                --text-main: #111827;
                --text-muted: #6b7280;
                --text-soft: #9ca3af;
                --radius-sm: 6px;
                --radius-md: 10px;
                --radius-lg: 14px;
                --shadow-soft: 0 8px 24px rgba(15, 23, 42, 0.08);
                --shadow-subtle: 0 4px 12px rgba(15, 23, 42, 0.06);
                --transition-fast: 0.18s ease-out;
                --transition-base: 0.24s ease;
            }
            
            /* CUSTOMER DROPDOWN SPECIFIC STYLES */
            /* These styles apply only to customer dropdown autocomplete items */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item {
                font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
                margin: 0;
                box-sizing: border-box;
                padding: 12px 15px;
                cursor: pointer;
                transition: all 0.2s;
                border-bottom: 1px solid var(--border-subtle);
            }
            
            /* Customer dropdown highlighted item */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item.highlighted {
                background: var(--primary);
                color: white;
                border-bottom: none;
            }
            
            /* Customer dropdown item hover */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item:hover {
                background: var(--primary-soft);
            }
            
            /* Customer dropdown highlighted item hover */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item.highlighted:hover {
                background: var(--primary-dark);
            }
            
            /* Customer dropdown item main content */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item .item-main strong {
                color: var(--text-main);
                font-weight: 500;
            }
            
            /* Customer dropdown highlighted item main content */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item.highlighted .item-main strong {
                color: white;
            }
            
            /* Customer dropdown badges */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item .item-badge {
                background: var(--bg-muted);
                color: var(--text-muted);
                padding: 3px 10px;
                border-radius: 12px;
                font-size: 11px;
                font-weight: 500;
            }
            
            /* Customer dropdown highlighted badges */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item.highlighted .item-badge {
                background: rgba(255, 255, 255, 0.25);
                color: rgba(255, 255, 255, 0.95);
            }
            
            /* Customer dropdown details */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item .item-details small {
                color: var(--text-muted);
            }
            
            /* Customer dropdown highlighted details */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item.highlighted .item-details small {
                color: rgba(255, 255, 255, 0.85);
            }
            
            /* Customer dropdown icons */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item .item-details i {
                color: var(--text-soft);
            }
            
            /* Customer dropdown highlighted icons */
            .autocomplete-dropdown.enhanced-dropdown .autocomplete-item.highlighted .item-details i {
                color: rgba(255, 255, 255, 0.8);
            }

            /* MODERN NOTIFICATION WIDGET STYLES - Like in the image */
.modern-notification-widget {
    position: fixed;
    top: 20px;
    right: 20px;
    width: 380px;
    background: var(--bg-card);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-soft);
    z-index: 9999;
    animation: slideInRight 0.4s ease;
    border-left: 5px solid transparent;
    overflow: hidden;
    font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
}

.modern-notification-widget.success {
    border-left-color: var(--accent);
    background: linear-gradient(to right, rgba(16, 185, 129, 0.05), var(--bg-card));
}

.modern-notification-widget.error {
    border-left-color: #ef4444;
    background: linear-gradient(to right, rgba(239, 68, 68, 0.05), var(--bg-card));
}

.modern-notification-widget.info {
    border-left-color: var(--primary);
    background: linear-gradient(to right, rgba(37, 99, 235, 0.05), var(--bg-card));
}

.modern-widget-content {
    padding: 25px;
    display: flex;
    gap: 20px;
    align-items: flex-start;
}

.modern-widget-icon {
    font-size: 36px;
    flex-shrink: 0;
    margin-top: 5px;
}

.modern-notification-widget.success .modern-widget-icon {
    color: var(--accent);
}

.modern-notification-widget.error .modern-widget-icon {
    color: #ef4444;
}

.modern-notification-widget.info .modern-widget-icon {
    color: var(--primary);
}

.modern-widget-details {
    flex: 1;
}

.modern-widget-details h3 {
    margin: 0 0 15px 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--text-main);
}

.modern-notification-widget.success .modern-widget-details h3 {
    color: var(--accent);
}

.modern-notification-widget.error .modern-widget-details h3 {
    color: #ef4444;
}

.modern-notification-widget.info .modern-widget-details h3 {
    color: var(--primary);
}

.modern-widget-details p {
    margin: 0 0 10px 0;
    color: var(--text-muted);
    line-height: 1.5;
    font-size: 14px;
}

.modern-widget-details p:last-child {
    margin-bottom: 20px;
}

.modern-widget-actions {
    display: flex;
    gap: 12px;
    margin-top: 20px;
}

.modern-btn {
    padding: 10px 24px;
    border-radius: var(--radius-sm);
    font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    font-weight: 500;
    font-size: 14px;
    cursor: pointer;
    transition: var(--transition-fast);
    border: none;
    outline: none;
}

.modern-btn-primary {
    background: var(--primary);
    color: white;
}

.modern-btn-primary:hover {
    background: var(--primary-dark);
    transform: translateY(-1px);
}

.modern-btn-secondary {
    background: var(--bg-muted);
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
}

.modern-btn-secondary:hover {
    background: var(--border-subtle);
}

@keyframes slideInRight {
    from {
        transform: translateX(100%);
        opacity: 0;
    }
    to {
        transform: translateX(0);
        opacity: 1;
    }
}

@keyframes slideOutRight {
    from {
        transform: translateX(0);
        opacity: 1;
    }
    to {
        transform: translateX(100%);
        opacity: 0;
    }
}

/* Remove old notification styles */
.notification,
.success-widget {
    display: none !important;
}
            
            /* GENERAL DROPDOWN STYLES (for other dropdowns) */
            /* Normal dropdown styles - simple like in the image */
            .normal-dropdown {
                width: 100%;
                padding: 12px 15px;
                border: 1px solid var(--border-subtle);
                border-radius: var(--radius-sm);
                font-size: 14px;
                font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
                background-color: var(--bg-card);
                cursor: pointer;
                appearance: none;
                -webkit-appearance: none;
                -moz-appearance: none;
                background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
                background-repeat: no-repeat;
                background-position: right 12px center;
                background-size: 16px;
                padding-right: 40px;
                color: var(--text-main);
                transition: var(--transition-fast);
                box-sizing: border-box;
            }
            
            .normal-dropdown:hover {
                border-color: var(--primary);
                box-shadow: var(--shadow-subtle);
            }
            
            .normal-dropdown:focus {
                border-color: var(--primary);
                outline: none;
                box-shadow: 0 0 0 3px var(--primary-soft);
            }
            
            .normal-dropdown option {
                padding: 10px 12px;
                font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
            }
            
            /* Autocomplete dropdown container */
            .autocomplete-dropdown.enhanced-dropdown {
                background: var(--bg-card);
                border: 1px solid var(--border-subtle);
                border-radius: var(--radius-md);
                box-shadow: var(--shadow-soft);
                max-height: 320px;
                overflow-y: auto;
                margin-top: 6px;
                padding: 0;
                font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
                animation: fadeInUp var(--transition-fast);
            }
            
            @keyframes fadeInUp {
                from {
                    opacity: 0;
                    transform: translateY(-4px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
            
            .dropdown-search-header {
                padding: 12px;
                background: var(--bg-muted);
                border-bottom: 1px solid var(--border-subtle);
                position: sticky;
                top: 0;
                z-index: 10;
                border-radius: var(--radius-md) var(--radius-md) 0 0;
            }
            
            .dropdown-search-header input {
                width: 100%;
                padding: 10px 12px 10px 38px;
                border: 1px solid var(--border-subtle);
                border-radius: var(--radius-sm);
                font-size: 14px;
                font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
                background-color: var(--bg-card);
                color: var(--text-main);
                transition: var(--transition-fast);
                box-sizing: border-box;
            }
            
            .dropdown-search-header input:focus {
                outline: none;
                border-color: var(--primary);
                box-shadow: 0 0 0 3px var(--primary-soft);
            }
            
            .dropdown-search-header i {
                position: absolute;
                left: 22px;
                top: 50%;
                transform: translateY(-50%);
                color: var(--text-muted);
                font-size: 14px;
            }
            
            /* Shipper dropdown specific styles (different from customer) */
            .shipper-dropdown .autocomplete-item {
                padding: 10px 15px;
                font-family: inherit;
            }
            
            .shipper-dropdown .autocomplete-item.highlighted {
                background: #007bff;
                color: white;
            }
            
            /* Requester dropdown specific styles */
            .autocomplete-dropdown.enhanced-dropdown:not(.shipper-dropdown):not(.port-dropdown):not(.cost-center-dropdown) .autocomplete-item.highlighted {
                background: #007bff;
                color: white;
            }
            
            .dropdown-region-header {
                padding: 10px 16px;
                background: var(--bg-muted);
                color: var(--text-muted);
                font-weight: 600;
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                border-bottom: 1px solid var(--border-subtle);
                font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
            }
            
            .item-main {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 6px;
            }
            
            .item-details {
                display: flex;
                gap: 12px;
                font-size: 12px;
                flex-wrap: wrap;
            }
            
            /* Edit button for auto-filled fields */
            .edit-auto-filled {
                position: absolute;
                right: 10px;
                top: 50%;
                transform: translateY(-50%);
                background: var(--accent);
                color: white;
                border: none;
                border-radius: var(--radius-sm);
                padding: 6px 10px;
                font-size: 12px;
                cursor: pointer;
                transition: var(--transition-fast);
                z-index: 5;
                font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
                box-sizing: border-box;
            }
            
            .edit-auto-filled:hover {
                background: var(--accent-dark);
                transform: translateY(-50%) scale(1.05);
            }
            
            /* Form group needs relative positioning for edit button */
            .form-group {
                position: relative;
            }
            
            .auto-filled {
                background-color: var(--accent-soft);
                border-color: var(--accent) !important;
                padding-right: 48px !important;
            }
            
            /* Success widget */
            .success-widget {
                background: linear-gradient(135deg, var(--accent), #0da271);
                color: white;
                border-radius: var(--radius-lg);
                padding: 20px;
                margin-bottom: 25px;
                animation: slideInDown 0.5s ease;
                box-shadow: 0 6px 20px rgba(16, 185, 129, 0.3);
                font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
            }
            
            .success-content {
                display: flex;
                align-items: center;
                gap: 20px;
            }
            
            .success-icon {
                font-size: 48px;
                opacity: 0.9;
            }
            
            .success-details h4 {
                margin: 0 0 8px 0;
                font-size: 18px;
                font-weight: 600;
            }
            
            .success-details p {
                margin: 0 0 15px 0;
                opacity: 0.9;
                font-size: 14px;
            }
            
            .success-actions {
                display: flex;
                gap: 10px;
            }
            
            /* Notification styling */
            .notification {
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 16px 24px;
                border-radius: var(--radius-md);
                display: flex;
                align-items: center;
                gap: 12px;
                box-shadow: var(--shadow-soft);
                z-index: 9999;
                animation: slideIn var(--transition-base);
                font-weight: 500;
                font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
            }
            
            .notification-success {
                background: var(--accent);
                color: white;
            }
            
            .notification-error {
                background: #ef4444;
                color: white;
            }
            
            .notification-info {
                background: var(--primary);
                color: white;
            }
            
            /* Animations */
            @keyframes slideInDown {
                from {
                    transform: translateY(-20px);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
            }
            
            @keyframes slideIn {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
            
            @keyframes slideOut {
                from {
                    transform: translateX(0);
                    opacity: 1;
                }
                to {
                    transform: translateX(100%);
                    opacity: 0;
                }
            }
            
            /* Scrollbar styling for dropdown */
            .autocomplete-dropdown.enhanced-dropdown::-webkit-scrollbar {
                width: 6px;
            }
            
            .autocomplete-dropdown.enhanced-dropdown::-webkit-scrollbar-track {
                background: var(--bg-muted);
                border-radius: 0 var(--radius-md) var(--radius-md) 0;
            }
            
            .autocomplete-dropdown.enhanced-dropdown::-webkit-scrollbar-thumb {
                background: var(--border-strong);
                border-radius: 3px;
            }
            
            .autocomplete-dropdown.enhanced-dropdown::-webkit-scrollbar-thumb:hover {
                background: var(--text-muted);
            }
            
            /* Ensure proper font loading */
            @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');
        `;
        document.head.appendChild(style);
    }
}