// excelExport.js - Dedicated Professional Excel Generator with Visual & Color Parity

window.exportAnalyticsToExcel = function(targetTallierId, configIntervalMinutes, records) {
    if (!records || records.length === 0) {
        alert('No records available to export.');
        return;
    }

    try {
        let sortedRecords = [...records];
        sortedRecords.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        let groupedByJunction = {};
        sortedRecords.forEach(rec => {
            const junction = rec.junction || 'Unknown Junction';
            if (!groupedByJunction[junction]) groupedByJunction[junction] = [];
            groupedByJunction[junction].push(rec);
        });

        let tableRowsHTML = '';
        let overallTotal = 0;
        let junctionIndex = 1;

        // Synchronized Vehicle Category Color Mapping matching web dashboard
        const categoryColors = {
            'Car': '#1d6fa5',        // Deep Blue
            'Truck': '#d9534f',      // Crimson Red
            'Bus': '#d97706',        // Amber / Orange
            'Motorcycle': '#16a34a', // Green
            'Bicycle': '#7c3aed',    // Purple
            'Pedestrian': '#db2777'  // Pink
        };

        for (const [junction, jRecords] of Object.entries(groupedByJunction)) {
            tableRowsHTML += `
                <tr style="background-color: #eef2f7; color: #1d6fa5; font-weight: bold; font-size: 11pt;">
                    <td colspan="5" style="border: 1px solid #cbd5e1; padding: 10px 12px; mso-number-format:'\\@';">
                        <strong>${junctionIndex}. Junction: ${junction}</strong>
                    </td>
                </tr>
            `;

            let intervalMs = configIntervalMinutes * 60 * 1000;
            let sessionStartTime = jRecords.length > 0 ? new Date(jRecords[0].timestamp).getTime() : Date.now();
            let intervalsMap = {};

            jRecords.forEach(rec => {
                const recTime = rec.timestamp ? new Date(rec.timestamp).getTime() : Date.now();
                const intervalIdx = Math.floor((recTime - sessionStartTime) / intervalMs);
                
                if (!intervalsMap[intervalIdx]) {
                    const intStart = new Date(sessionStartTime + (intervalIdx * intervalMs));
                    const intEnd = new Date(sessionStartTime + ((intervalIdx + 1) * intervalMs));
                    intervalsMap[intervalIdx] = {
                        label: `${intStart.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - ${intEnd.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`,
                        aggregates: {}
                    };
                }

                const route = rec.route || 'N/A';
                const category = rec.category || 'N/A';
                const mapKey = route + '__' + category;
                const count = Number(rec.count || 0);

                if (!intervalsMap[intervalIdx].aggregates[mapKey]) {
                    intervalsMap[intervalIdx].aggregates[mapKey] = { route: route, category: category, count: 0 };
                }
                intervalsMap[intervalIdx].aggregates[mapKey].count += count;
            });

            let cumulativeRunningTotal = 0;
            let intervalKeys = Object.keys(intervalsMap).sort((a, b) => Number(a) - Number(b));

            intervalKeys.forEach((intKey) => {
                const intervalObj = intervalsMap[intKey];
                let intervalTotalCount = 0;

                for (const [mapKey, agg] of Object.entries(intervalObj.aggregates)) {
                    intervalTotalCount += agg.count;
                    overallTotal += agg.count;

                    const catColor = categoryColors[agg.category] || '#334155';

                    tableRowsHTML += `
                        <tr>
                            <td style="text-align: center; width: 40px; color: #94a3b8; border: 1px solid #e2e8f0; padding: 8px 12px; font-size: 10.5pt; mso-number-format:'\\@';">↳</td>
                            <td style="border: 1px solid #e2e8f0; padding: 8px 12px; color: #0f172a; font-size: 10.5pt; mso-number-format:'\\@';"><strong>${agg.route}</strong></td>
                            <td style="border: 1px solid #e2e8f0; padding: 8px 12px; font-weight: bold; color: ${catColor}; font-size: 10.5pt; mso-number-format:'\\@';">${agg.category}</td>
                            <td style="border: 1px solid #e2e8f0; padding: 8px 12px; color: #475569; font-size: 10.5pt; mso-number-format:'\\@';">${intervalObj.label}</td>
                            <td style="text-align: right; color: ${catColor}; font-weight: bold; border: 1px solid #e2e8f0; padding: 8px 12px; font-size: 10.5pt; mso-number-format:'0';">${agg.count}</td>
                        </tr>
                    `;
                }

                cumulativeRunningTotal += intervalTotalCount;

                tableRowsHTML += `
                    <tr style="background-color: #f1f5f9; font-weight: bold; border-top: 1.5px dashed #1d6fa5; border-bottom: 1.5px dashed #1d6fa5;">
                        <td colspan="4" style="text-align: right; color: #1d6fa5; border: 1px solid #e2e8f0; padding: 8px 12px; font-size: 10.5pt; mso-number-format:'\\@';">[${configIntervalMinutes}-Min Interval Summary - Cumulative Total]:</td>
                        <td style="text-align: right; color: #1d6fa5; border: 1px solid #e2e8f0; padding: 8px 12px; font-size: 10.5pt; mso-number-format:'0';">${cumulativeRunningTotal}</td>
                    </tr>
                `;
            });
            junctionIndex++;
        }

        tableRowsHTML += `
            <tr style="background-color: #dcfce7; font-weight: bold; font-size: 11.5pt; color: #166534;">
                <td colspan="4" style="text-align: right; border: 1px solid #bbf7d0; padding: 12px; mso-number-format:'\\@';">Overall Total Count:</td>
                <td style="text-align: right; border: 1px solid #bbf7d0; padding: 12px; font-size: 11.5pt; mso-number-format:'0';">${overallTotal}</td>
            </tr>
        `;

        const excelHTML = `
            <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
            <head>
                <meta charset="UTF-8">
                <!--[if gte mso 9]>
                <xml>
                    <x:ExcelWorkbook>
                        <x:ExcelWorksheets>
                            <x:ExcelWorksheet>
                                <x:Name>Traffic Analytics</x:Name>
                                <x:WorksheetOptions>
                                    <x:DisplayGridlines/>
                                </x:WorksheetOptions>
                            </x:ExcelWorksheet>
                        </x:ExcelWorksheets>
                    </x:ExcelWorkbook>
                </xml>
                <![endif]-->
                <style>
                    body { font-family: 'Segoe UI', Arial, sans-serif; color: #334155; }
                    table { border-collapse: collapse; width: 100%; }
                    th { background-color: #2b3e50; color: #ffffff; padding: 12px; border: 1px solid #1e293b; text-align: left; font-weight: bold; font-size: 11pt; }
                    td { padding: 8px 12px; font-size: 10.5pt; }
                </style>
            </head>
            <body>
                <h2 style="color: #2b3e50; margin-bottom: 5px; font-family: 'Segoe UI', Arial;">Traffic Tally Analytics Report</h2>
                <p style="color: #64748b; margin-top: 0; font-size: 10.5pt; font-family: 'Segoe UI', Arial;">
                    <strong>Tallier:</strong> ${targetTallierId} &nbsp;|&nbsp; 
                    <strong>Generated on:</strong> ${new Date().toLocaleString()} &nbsp;|&nbsp; 
                    <strong>Interval:</strong> ${configIntervalMinutes} mins
                </p>
                <br/>
                <table>
                    <thead>
                        <tr>
                            <th style="width: 40px; text-align: center; mso-number-format:'\\@';">&nbsp;</th>
                            <th style="width: 200px; mso-number-format:'\\@';">Route</th>
                            <th style="width: 150px; mso-number-format:'\\@';">Vehicle Category</th>
                            <th style="width: 200px; mso-number-format:'\\@';">Time Interval</th>
                            <th style="width: 130px; text-align: right; mso-number-format:'\\@';">Aggregated Count</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRowsHTML}
                    </tbody>
                </table>
            </body>
            </html>
        `;

        const blob = new Blob(['\ufeff' + excelHTML], { type: 'application/vnd.ms-excel' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const todayStr = new Date().toISOString().split('T')[0];
        a.download = targetTallierId + '_Analytics_' + todayStr + '.xls';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
    } catch (err) {
        console.error('Excel export error:', err);
        alert('Could not download Excel report.');
    }
};