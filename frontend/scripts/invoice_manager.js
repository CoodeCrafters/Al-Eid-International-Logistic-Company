// Invoice Manager for handling invoice form
class InvoiceManager {
    constructor(dashboardApp) {
        this.dashboardApp = dashboardApp;
        this.setupInvoiceForm();
    }

    setupInvoiceForm() {
        const invoiceForm = document.getElementById('invoiceForm');
        if (!invoiceForm) return;

        // Add charge button
        const addChargeBtn = document.getElementById('addChargeBtn');
        if (addChargeBtn) {
            addChargeBtn.addEventListener('click', () => this.addChargeRow());
        }

        // Tax input change
        const taxInput = document.getElementById('tax');
        if (taxInput) {
            taxInput.addEventListener('input', () => this.dashboardApp.updateInvoiceTotals());
        }

        // Advance amount change
        const advanceAmountInput = document.getElementById('advanceAmount');
        if (advanceAmountInput) {
            advanceAmountInput.addEventListener('input', () => this.dashboardApp.updateInvoiceTotals());
        }

        // Form submission
        invoiceForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.dashboardApp.saveInvoice();
        });

        // Cancel button
        const cancelBtn = document.getElementById('cancelInvoiceBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                this.dashboardApp.closeModal('invoiceModal');
            });
        }
    }

    addChargeRow(chargeData = null) {
        this.dashboardApp.addChargeRow(chargeData);
    }
}

// Initialize when dashboard is ready
document.addEventListener('DOMContentLoaded', () => {
    if (window.dashboardApp) {
        window.invoiceManager = new InvoiceManager(window.dashboardApp);
    }
});

export { InvoiceManager };