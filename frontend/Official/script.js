// Global settlement data
let settlementData = {};

// Initialize form with default values
function initializeForm() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    // Set default dates
    document.getElementById('appointmentDate').value = '2015-04-05';
    document.getElementById('endServiceDate').value = '2025-10-07';
    document.getElementById('lastReturnDate').value = '2025-05-10';
    document.getElementById('salaryFromDate').value = '2025-10-01';
    document.getElementById('salaryToDate').value = '2025-10-07';
    document.getElementById('balanceLeaveDays').value = '0';
    document.getElementById('unpaidLeaveDays').value = '167.14';
    document.getElementById('basicSalary').value = '500';
    document.getElementById('employeeName').value = 'AMIR SULTAN NAZIR MUHAMMAD';
    document.getElementById('profession').value = 'Sales';
    
    // Set bank info
    document.getElementById('bankAccount').value = 'KW52COMB0000349548784201414012';
    document.getElementById('bankName').value = 'CBK Bank';
    
    // Initialize display
    updateDisplay();
    calculateSettlement();
}

// Update display fields
function updateDisplay() {
    const employeeName = document.getElementById('employeeName').value;
    const bankAccount = document.getElementById('bankAccount').value;
    const bankName = document.getElementById('bankName').value;
    
    document.getElementById('employeeNameDisplay').textContent = employeeName;
    document.getElementById('bankAccountDisplay').textContent = bankAccount;
    document.getElementById('bankNameDisplay').textContent = bankName;
}

// Calculate settlement
function calculateSettlement() {
    // Get form values
    const basicSalary = parseFloat(document.getElementById('basicSalary').value) || 0;
    const appointmentDate = new Date(document.getElementById('appointmentDate').value);
    const endServiceDate = new Date(document.getElementById('endServiceDate').value);
    const unpaidLeaveDays = parseFloat(document.getElementById('unpaidLeaveDays').value) || 0;
    const lastReturnDate = new Date(document.getElementById('lastReturnDate').value);
    const balanceLeaveDays = parseFloat(document.getElementById('balanceLeaveDays').value) || 0;
    const salaryFromDate = document.getElementById('salaryFromDate').value ? new Date(document.getElementById('salaryFromDate').value) : null;
    const salaryToDate = document.getElementById('salaryToDate').value ? new Date(document.getElementById('salaryToDate').value) : null;
    
    // Calculate daily salary
    const dailySalary = basicSalary / 26;
    
    // Calculate total service days
    const totalServiceDays = Math.floor((endServiceDate - appointmentDate) / (1000 * 60 * 60 * 24));
    
    // Calculate total worked days
    const totalWorkedDays = totalServiceDays - unpaidLeaveDays;
    
    // Calculate service years and remaining days
    const serviceYears = Math.floor(totalWorkedDays / 365);
    const remainingDays = totalWorkedDays % 365;
    const remainingYearsFraction = remainingDays / 365;
    
    // Calculate indemnity
    let first5YearsAmount = 0;
    let next5YearsAmount = 0;
    let additionalDaysAmount = 0;
    let totalIndemnity = 0;
    
    if (serviceYears >= 5) {
        // First 5 years
        first5YearsAmount = dailySalary * 15 * 5;
        
        // Next 5 years (years 6-10)
        if (serviceYears >= 10) {
            next5YearsAmount = dailySalary * 30 * 5;
            // Additional years beyond 10
            const additionalYears = serviceYears - 10;
            if (additionalYears > 0) {
                next5YearsAmount += dailySalary * 30 * additionalYears;
            }
            // Remaining days
            additionalDaysAmount = dailySalary * 30 * remainingYearsFraction;
        } else {
            // Years 6-10 (partial)
            const nextYears = serviceYears - 5;
            next5YearsAmount = dailySalary * 30 * nextYears;
            additionalDaysAmount = dailySalary * 30 * remainingYearsFraction;
        }
    } else {
        // Less than 5 years
        first5YearsAmount = dailySalary * 15 * serviceYears;
        additionalDaysAmount = dailySalary * 15 * remainingYearsFraction;
    }
    
    totalIndemnity = first5YearsAmount + next5YearsAmount + additionalDaysAmount;
    
    // Calculate unpaid leave
    const daysSinceLastReturn = Math.floor((endServiceDate - lastReturnDate) / (1000 * 60 * 60 * 24));
    const dailyAccrualRate = 30 / 365;
    const earnedLeaveDays = daysSinceLastReturn * dailyAccrualRate;
    const unpaidLeaveAmount = Math.max(0, earnedLeaveDays - balanceLeaveDays) * dailySalary;
    
    // Calculate last salary
    let lastSalaryDays = 0;
    let lastSalaryAmount = 0;
    
    if (salaryFromDate && salaryToDate) {
        lastSalaryDays = Math.floor((salaryToDate - salaryFromDate) / (1000 * 60 * 60 * 24)) + 1;
        lastSalaryAmount = lastSalaryDays * dailySalary;
    }
    
    // Calculate deductions (from inputs)
    const loanDeduction = 0; // Could add input field for this
    const pettyCashDeduction = 0; // Could add input field for this
    const totalDeductions = loanDeduction + pettyCashDeduction;
    
    // Calculate total due
    const totalDue = totalIndemnity + unpaidLeaveAmount + lastSalaryAmount - totalDeductions;
    
    // Store data
    settlementData = {
        employeeName: document.getElementById('employeeName').value,
        profession: document.getElementById('profession').value,
        basicSalary: basicSalary,
        dailySalary: dailySalary,
        appointmentDate: document.getElementById('appointmentDate').value,
        endServiceDate: document.getElementById('endServiceDate').value,
        totalServiceDays: totalServiceDays,
        unpaidLeaveDays: unpaidLeaveDays,
        totalWorkedDays: totalWorkedDays,
        serviceYears: serviceYears,
        remainingDays: remainingDays,
        first5YearsAmount: first5YearsAmount,
        next5YearsAmount: next5YearsAmount,
        additionalDaysAmount: additionalDaysAmount,
        totalIndemnity: totalIndemnity,
        lastReturnDate: document.getElementById('lastReturnDate').value,
        balanceLeaveDays: balanceLeaveDays,
        daysSinceLastReturn: daysSinceLastReturn,
        earnedLeaveDays: earnedLeaveDays,
        unpaidLeaveAmount: unpaidLeaveAmount,
        lastSalaryDays: lastSalaryDays,
        lastSalaryAmount: lastSalaryAmount,
        loanDeduction: loanDeduction,
        pettyCashDeduction: pettyCashDeduction,
        totalDeductions: totalDeductions,
        totalDue: totalDue,
        bankAccount: document.getElementById('bankAccount').value,
        bankName: document.getElementById('bankName').value
    };
    
    // Update display
    updateCalculations();
    updateTableData();
}

// Update calculation results display
function updateCalculations() {
    document.getElementById('dailySalaryCalc').textContent = `KWD ${settlementData.dailySalary.toFixed(3)}`;
    document.getElementById('totalServiceDays').textContent = `${settlementData.totalServiceDays} Days`;
    document.getElementById('totalWorkedDays').textContent = `${settlementData.totalWorkedDays.toFixed(2)} Days`;
    document.getElementById('serviceYears').textContent = `${settlementData.serviceYears} Years and ${settlementData.remainingDays.toFixed(1)} Days`;
}

// Update table data
function updateTableData() {
    // Update indemnity table
    const dailySalary = settlementData.dailySalary;
    
    document.getElementById('dailySalaryCell1').textContent = dailySalary.toFixed(3);
    document.getElementById('dailySalaryCell2').textContent = dailySalary.toFixed(3);
    document.getElementById('dailySalaryCell3').textContent = dailySalary.toFixed(3);
    
    const years1 = Math.min(settlementData.serviceYears, 5);
    const years2 = settlementData.serviceYears >= 10 ? 5 : Math.max(0, settlementData.serviceYears - 5);
    const years3 = settlementData.remainingDays / 365;
    
    document.getElementById('years1').textContent = years1;
    document.getElementById('years2').textContent = years2;
    document.getElementById('years3').textContent = years3.toFixed(3);
    
    document.getElementById('amount1').textContent = settlementData.first5YearsAmount.toFixed(3);
    document.getElementById('amount2').textContent = settlementData.next5YearsAmount.toFixed(3);
    document.getElementById('amount3').textContent = settlementData.additionalDaysAmount.toFixed(3);
    document.getElementById('totalIndemnity').textContent = `KWD ${settlementData.totalIndemnity.toFixed(3)}`;
    
    // Update unpaid leave table
    document.getElementById('lastReturnDateCell').textContent = formatDate(settlementData.lastReturnDate);
    document.getElementById('balanceLeaveCell').textContent = `${settlementData.balanceLeaveDays} Days`;
    document.getElementById('workedPeriodCell').textContent = `${settlementData.daysSinceLastReturn} days`;
    document.getElementById('dailyAccrualCell').textContent = `${(30/365).toFixed(6)} per day`;
    document.getElementById('earnedLeaveCell').textContent = `${settlementData.earnedLeaveDays.toFixed(2)} days`;
    document.getElementById('unpaidLeaveAmountCell').textContent = `KWD ${settlementData.unpaidLeaveAmount.toFixed(5)}`;
    
    // Update last salary table
    document.getElementById('salaryFromCell').textContent = document.getElementById('salaryFromDate').value;
    document.getElementById('salaryToCell').textContent = document.getElementById('salaryToDate').value;
    document.getElementById('workedDaysCell').textContent = `${settlementData.lastSalaryDays} working days`;
    document.getElementById('unpaidDaysDetail').textContent = `${settlementData.lastSalaryDays} × ${dailySalary.toFixed(3)}`;
    document.getElementById('lastSalaryAmountCell').textContent = `KWD ${settlementData.lastSalaryAmount.toFixed(3)}`;
    
    // Update deductions table
    document.getElementById('loanDeductionCell').textContent = settlementData.loanDeduction.toFixed(3);
    document.getElementById('pettyCashDeductionCell').textContent = settlementData.pettyCashDeduction.toFixed(3);
    document.getElementById('totalDeductionsCell').textContent = settlementData.totalDeductions.toFixed(3);
    
    // Update final settlement table
    document.getElementById('totalIndemnityFinal').textContent = `KWD ${settlementData.totalIndemnity.toFixed(3)}`;
    document.getElementById('finalIndemnityCell').textContent = `KWD ${settlementData.totalIndemnity.toFixed(3)}`;
    document.getElementById('finalUnpaidLeaveCell').textContent = `KWD ${settlementData.unpaidLeaveAmount.toFixed(5)}`;
    document.getElementById('finalLastSalaryCell').textContent = `KWD ${settlementData.lastSalaryAmount.toFixed(3)}`;
    document.getElementById('finalDeductionsCell').textContent = settlementData.totalDeductions.toFixed(3);
    document.getElementById('totalDueCell').textContent = `KWD ${settlementData.totalDue.toFixed(3)}`;
    
    // Update amount in words
    document.getElementById('amountInWords').textContent = `Amount in Words: ${numberToWords(settlementData.totalDue)}`;
}

// Format date
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toISOString().split('T')[0];
}

// Convert number to words
function numberToWords(num) {
    const units = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const thousands = ['', 'Thousand', 'Million', 'Billion'];
    
    if (num === 0) return 'Zero';
    
    let words = '';
    let wholePart = Math.floor(num);
    let fractionalPart = Math.round((num - wholePart) * 1000);
    
    // Convert whole part
    let i = 0;
    while (wholePart > 0) {
        if (wholePart % 1000 !== 0) {
            words = convertHundreds(wholePart % 1000) + thousands[i] + ' ' + words;
        }
        wholePart = Math.floor(wholePart / 1000);
        i++;
    }
    
    words = words.trim() + ' Kuwaiti Dinars';
    
    // Add fractional part
    if (fractionalPart > 0) {
        words += ` & ${fractionalPart.toString().padStart(3, '0')}/1000 Fils`;
    }
    
    words += ' Only.';
    return words;
    
    function convertHundreds(num) {
        let result = '';
        
        // Hundreds
        if (num >= 100) {
            result += units[Math.floor(num / 100)] + ' Hundred ';
            num %= 100;
        }
        
        // Tens and units
        if (num >= 20) {
            result += tens[Math.floor(num / 10)] + ' ';
            num %= 10;
        } else if (num >= 10) {
            result += teens[num - 10] + ' ';
            return result;
        }
        
        // Units
        if (num > 0) {
            result += units[num] + ' ';
        }
        
        return result;
    }
}

// Generate PDF
function generatePDF() {
    if (!settlementData.employeeName) {
        alert('Please calculate settlement first!');
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p', 'mm', 'a4');
    
    // Set font
    doc.setFont('helvetica');
    
    // Title
    doc.setFontSize(16);
    doc.setTextColor(30, 60, 114);
    doc.text('END OF SERVICE SETTLEMENT', 105, 20, null, null, 'center');
    
    // Employee Information
    doc.setFontSize(12);
    doc.setTextColor(0, 0, 0);
    let yPos = 40;
    
    // Create table-like structure for employee info
    doc.setFillColor(30, 60, 114);
    doc.rect(20, yPos-10, 170, 10, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text('Employee Information', 25, yPos-3);
    
    yPos += 5;
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(10);
    
    doc.text(`Employee Name: ${settlementData.employeeName}`, 25, yPos);
    doc.text(`Profession / Job: ${settlementData.profession}`, 25, yPos + 7);
    doc.text(`Basic Salary: KWD ${settlementData.basicSalary.toFixed(3)}`, 25, yPos + 14);
    doc.text(`Daily Salary: KWD ${settlementData.dailySalary.toFixed(3)}`, 25, yPos + 21);
    
    yPos += 35;
    
    // Service Period
    doc.setFillColor(30, 60, 114);
    doc.rect(20, yPos-10, 170, 10, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text('Service Period', 25, yPos-3);
    
    yPos += 5;
    doc.setTextColor(0, 0, 0);
    
    doc.text(`Date of Appointment: ${settlementData.appointmentDate}`, 25, yPos);
    doc.text(`End of Service Date: ${settlementData.endServiceDate}`, 25, yPos + 7);
    doc.text(`Total Service Days: ${settlementData.totalServiceDays} Days`, 25, yPos + 14);
    doc.text(`Unpaid Leave Days: ${settlementData.unpaidLeaveDays} Days`, 25, yPos + 21);
    doc.text(`Final Total Worked Days: ${settlementData.totalWorkedDays.toFixed(2)} Days`, 25, yPos + 28);
    doc.text(`Service Period: ${settlementData.serviceYears} Years and ${settlementData.remainingDays.toFixed(1)} Days`, 25, yPos + 35);
    
    yPos += 45;
    
    // Working Period Indemnity Calculations
    doc.setFillColor(30, 60, 114);
    doc.rect(20, yPos-10, 170, 10, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text('Working Period Indemnity Calculations', 25, yPos-3);
    
    yPos += 5;
    doc.setTextColor(0, 0, 0);
    
    // Create indemnity table
    doc.autoTable({
        startY: yPos,
        head: [['Description', 'Daily Salary', 'Days/Year', 'Years', 'Amount (KWD)']],
        body: [
            ['First 5 years of service', settlementData.dailySalary.toFixed(3), '15', Math.min(settlementData.serviceYears, 5), settlementData.first5YearsAmount.toFixed(3)],
            ['Next 5 years of service', settlementData.dailySalary.toFixed(3), '30', Math.max(0, settlementData.serviceYears - 5), settlementData.next5YearsAmount.toFixed(3)],
            ['Additional days indemnity', settlementData.dailySalary.toFixed(3), '30', (settlementData.remainingDays/365).toFixed(3), settlementData.additionalDaysAmount.toFixed(3)],
            ['Total Working Period Indemnity', '', '', '', settlementData.totalIndemnity.toFixed(3)]
        ],
        headStyles: { fillColor: [30, 60, 114], textColor: [255, 255, 255] },
        bodyStyles: { textColor: [0, 0, 0] },
        alternateRowStyles: { fillColor: [240, 240, 240] },
        margin: { left: 20 },
        theme: 'grid'
    });
    
    yPos = doc.lastAutoTable.finalY + 10;
    
    // Continue with other sections...
    // Add the rest of the sections similar to above
    
    // Save PDF
    const fileName = `End_of_Service_Settlement_${settlementData.employeeName.replace(/\s+/g, '_')}.pdf`;
    doc.save(fileName);
}

// Reset form
function resetForm() {
    if (confirm('Are you sure you want to reset the form? All data will be lost.')) {
        document.getElementById('settlementForm').reset();
        initializeForm();
    }
}

// Initialize on page load
window.onload = initializeForm;

// Add event listeners for real-time updates
document.addEventListener('DOMContentLoaded', function() {
    const inputs = document.querySelectorAll('input');
    inputs.forEach(input => {
        input.addEventListener('change', function() {
            updateDisplay();
            calculateSettlement();
        });
        input.addEventListener('input', function() {
            if (this.type === 'text' || this.type === 'number') {
                updateDisplay();
            }
        });
    });
});