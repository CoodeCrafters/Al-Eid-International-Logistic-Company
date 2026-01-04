// Sidebar Management
class SidebarManager {
    constructor() {
        this.sidebar = document.querySelector('.sidebar');
        this.toggleBtn = document.getElementById('toggleSidebar');
        this.mobileToggleBtn = document.getElementById('mobileMenuToggle');
        this.mainContent = document.querySelector('.main-content');
        this.isCollapsed = false;
        
        this.init();
    }

    init() {
        // Load saved sidebar state
        const savedState = localStorage.getItem('sidebarCollapsed');
        if (savedState === 'true') {
            this.collapseSidebar();
        }

        // Set up event listeners
        this.setupEventListeners();
        
        // Handle responsive behavior
        this.handleResponsive();
    }

    setupEventListeners() {
        // Desktop toggle button
        if (this.toggleBtn) {
            this.toggleBtn.addEventListener('click', () => this.toggleSidebar());
        }

        // Mobile menu button
        if (this.mobileToggleBtn) {
            this.mobileToggleBtn.addEventListener('click', () => this.toggleMobileMenu());
        }

        // Menu item clicks
        document.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                this.setActiveMenuItem(item);
                
                // Close sidebar on mobile after selection
                if (window.innerWidth <= 1024) {
                    this.closeMobileMenu();
                }
            });
        });

        // Navigation link clicks
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.setActiveNavLink(link);
            });
        });

        // Close sidebar when clicking outside on mobile
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 1024 && 
                !this.sidebar.contains(e.target) && 
                !this.mobileToggleBtn.contains(e.target) && 
                this.sidebar.classList.contains('active')) {
                this.closeMobileMenu();
            }
        });

        // Handle window resize
        window.addEventListener('resize', () => this.handleResponsive());
    }

    toggleSidebar() {
        this.isCollapsed = !this.isCollapsed;
        
        if (this.isCollapsed) {
            this.collapseSidebar();
        } else {
            this.expandSidebar();
        }
        
        // Save state
        localStorage.setItem('sidebarCollapsed', this.isCollapsed);
    }

    collapseSidebar() {
        this.sidebar.classList.add('collapsed');
        this.isCollapsed = true;
    }

    expandSidebar() {
        this.sidebar.classList.remove('collapsed');
        this.isCollapsed = false;
    }

    toggleMobileMenu() {
        this.sidebar.classList.toggle('active');
        
        // Prevent body scroll when menu is open
        if (this.sidebar.classList.contains('active')) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
    }

    closeMobileMenu() {
        this.sidebar.classList.remove('active');
        document.body.style.overflow = '';
    }

    setActiveMenuItem(menuItem) {
        // Remove active class from all menu items
        document.querySelectorAll('.menu-item').forEach(item => {
            item.classList.remove('active');
        });
        
        // Add active class to clicked item
        menuItem.classList.add('active');
    }

    setActiveNavLink(navLink) {
        // Remove active class from all nav links
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
        });
        
        // Add active class to clicked link
        navLink.classList.add('active');
    }

    handleResponsive() {
        if (window.innerWidth <= 1024) {
            // On mobile, ensure sidebar is hidden by default
            if (!this.sidebar.classList.contains('collapsed')) {
                this.sidebar.classList.add('collapsed');
            }
            
            // Show mobile menu button
            if (this.mobileToggleBtn) {
                this.mobileToggleBtn.style.display = 'flex';
            }
        } else {
            // On desktop, restore saved state
            if (this.isCollapsed) {
                this.sidebar.classList.add('collapsed');
            } else {
                this.sidebar.classList.remove('collapsed');
            }
            
            // Ensure sidebar is visible on desktop
            this.sidebar.classList.remove('active');
            document.body.style.overflow = '';
            
            // Hide mobile menu button
            if (this.mobileToggleBtn) {
                this.mobileToggleBtn.style.display = 'none';
            }
        }
    }
}

// Initialize sidebar when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.sidebarManager = new SidebarManager();
});

// Export for use in other modules
export { SidebarManager };