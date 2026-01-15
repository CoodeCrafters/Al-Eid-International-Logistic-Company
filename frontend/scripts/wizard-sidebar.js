// Wizard-specific sidebar with minimal functionality
class WizardSidebarManager {
    constructor() {
        this.sidebarHTML = `
            <aside class="sidebar" id="sidebar">
                <div class="sidebar-header">
                    <div class="sidebar-brand">
                        <i class="fas fa-crown"></i>
                        <span class="brand-text">JBCroWn</span>
                    </div>
                    <button class="sidebar-toggle" id="sidebarToggle">
                        <i class="fas fa-chevron-left"></i>
                    </button>
                </div>
                
                <div class="sidebar-content">
                    <nav class="sidebar-nav">
                        <a href="home.html" class="nav-item">
                            <i class="fas fa-home"></i>
                            <span class="nav-text">Dashboard</span>
                        </a>
                        <a href="#" class="nav-item active">
                            <i class="fas fa-wand-magic-sparkles"></i>
                            <span class="nav-text">Charges Wizard</span>
                        </a>
                        <a href="job-cards.html" class="nav-item">
                            <i class="fas fa-clipboard-list"></i>
                            <span class="nav-text">Job Cards</span>
                        </a>
                        <a href="create-job-card.html" class="nav-item">
                            <i class="fas fa-plus-circle"></i>
                            <span class="nav-text">New Job Card</span>
                        </a>
                        <a href="invoices.html" class="nav-item">
                            <i class="fas fa-file-invoice-dollar"></i>
                            <span class="nav-text">Invoices</span>
                        </a>
                    </nav>
                    
                    <div class="sidebar-footer">
                        <div class="user-profile">
                            <div class="user-avatar">
                                <i class="fas fa-user-circle"></i>
                            </div>
                            <div class="user-info">
                                <span class="user-name" id="userName">Loading...</span>
                                <span class="user-role" id="userRole">Administrator</span>
                            </div>
                            <button class="logout-btn" onclick="logout()">
                                <i class="fas fa-sign-out-alt"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </aside>
        `;
    }

    initialize() {
        // Inject sidebar HTML
        const sidebarContainer = document.getElementById('sidebar-container');
        if (sidebarContainer) {
            sidebarContainer.innerHTML = this.sidebarHTML;
            this.initEventListeners();
            this.loadUserData();
        }
    }

    initEventListeners() {
        // Toggle sidebar
        const toggleBtn = document.getElementById('sidebarToggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.toggleSidebar());
        }
    }

    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const appContainer = document.querySelector('.app-container');
        const toggleIcon = document.querySelector('.sidebar-toggle i');
        
        if (sidebar && appContainer && toggleIcon) {
            sidebar.classList.toggle('collapsed');
            appContainer.classList.toggle('sidebar-collapsed');
            
            if (sidebar.classList.contains('collapsed')) {
                toggleIcon.classList.remove('fa-chevron-left');
                toggleIcon.classList.add('fa-chevron-right');
            } else {
                toggleIcon.classList.remove('fa-chevron-right');
                toggleIcon.classList.add('fa-chevron-left');
            }
        }
    }

    loadUserData() {
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
    }
}

// Export for use in other modules
export { WizardSidebarManager };