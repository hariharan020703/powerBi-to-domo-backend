import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
/**
 * Parses a Power BI `.pbix` file to extract its dashboard structure (pages, visuals, columns, and formulas).
 *
 * @param filePath The absolute path to the `.pbix` file.
 */
export function parsePbix(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found at path: ${filePath}`);
    }
    const stats = fs.statSync(filePath);
    const fileSizeMb = Number((stats.size / (1024 * 1024)).toFixed(2));
    const fileName = path.basename(filePath);
    let zip;
    try {
        zip = new AdmZip(filePath);
    }
    catch (err) {
        throw new Error(`Failed to read file as a zip archive: ${err.message}. Make sure it is a valid, unencrypted .pbix file.`);
    }
    const entries = zip.getEntries();
    // Locate the Report/Layout file
    const layoutEntry = entries.find((entry) => entry.entryName === 'Report/Layout' || entry.entryName === 'Report\\Layout');
    if (!layoutEntry) {
        throw new Error('Could not find Report/Layout inside the PBIX file structure. It might be corrupted or not a valid Power BI report.');
    }
    // The Report/Layout file is typically UTF-16LE encoded.
    let rawLayoutText;
    try {
        rawLayoutText = zip.readAsText(layoutEntry, 'utf-16le');
    }
    catch (err) {
        throw new Error(`Failed to decode Report/Layout as UTF-16LE: ${err.message}`);
    }
    // Clean the layout text by removing any leading BOM or trailing null/control characters
    // that can crash JSON.parse()
    let cleanedLayoutText = rawLayoutText;
    if (cleanedLayoutText.charCodeAt(0) === 0xFEFF) {
        cleanedLayoutText = cleanedLayoutText.substring(1);
    }
    // Replace null bytes and common control chars that might appear in the stream
    cleanedLayoutText = cleanedLayoutText.replace(/\0/g, '');
    let layoutJson;
    try {
        layoutJson = JSON.parse(cleanedLayoutText);
    }
    catch (err) {
        throw new Error(`Failed to parse Layout JSON: ${err.message}`);
    }
    const pages = [];
    const visualTypesCount = {};
    let totalVisuals = 0;
    if (layoutJson && Array.isArray(layoutJson.sections)) {
        for (const section of layoutJson.sections) {
            const pageName = section.name;
            const pageDisplayName = section.displayName || pageName;
            const visuals = [];
            if (Array.isArray(section.visualContainers)) {
                for (const container of section.visualContainers) {
                    let visualType = 'unknown';
                    let visualName = container.name || `visual-${totalVisuals + 1}`;
                    const columns = [];
                    const formulas = [];
                    // Visual metadata is stored inside a stringified JSON in the "config" property
                    if (container.config) {
                        try {
                            const configJson = JSON.parse(container.config);
                            if (configJson.singleVisual) {
                                visualType = configJson.singleVisual.visualType || 'unknown';
                                // 1. Visual Title/Name
                                if (configJson.singleVisual.objects) {
                                    const titleObj = configJson.singleVisual.objects.title;
                                    if (titleObj && Array.isArray(titleObj) && titleObj[0]?.properties?.text?.expr?.Literal?.Value) {
                                        visualName = titleObj[0].properties.text.expr.Literal.Value.replace(/'/g, '');
                                    }
                                }
                                // 2. Bound columns from projections (axis roles)
                                if (configJson.singleVisual.projections) {
                                    for (const roleName of Object.keys(configJson.singleVisual.projections)) {
                                        const roleProj = configJson.singleVisual.projections[roleName];
                                        if (Array.isArray(roleProj)) {
                                            for (const proj of roleProj) {
                                                if (proj.queryRef) {
                                                    columns.push(`${roleName}: ${proj.queryRef}`);
                                                }
                                            }
                                        }
                                    }
                                }
                                // 3. Expressions/calculations from prototypeQuery selects
                                if (configJson.singleVisual.prototypeQuery && Array.isArray(configJson.singleVisual.prototypeQuery.select)) {
                                    for (const selectItem of configJson.singleVisual.prototypeQuery.select) {
                                        if (selectItem.name) {
                                            const queryRef = selectItem.queryRef;
                                            if (selectItem.expression) {
                                                try {
                                                    const expr = selectItem.expression;
                                                    if (expr.SourceRef && expr.SourceRef.source) {
                                                        // Standard column reference
                                                        columns.push(queryRef || selectItem.name);
                                                    }
                                                    else {
                                                        // Aggregation or formula
                                                        const formulaName = queryRef || selectItem.name;
                                                        let calculation = '';
                                                        if (expr.Aggregation && expr.Aggregation.expression?.SourceRef) {
                                                            calculation = `${expr.Aggregation.function}(${expr.Aggregation.expression.SourceRef.source}.${expr.Aggregation.expression.SourceRef.property || ''})`;
                                                        }
                                                        else {
                                                            calculation = JSON.stringify(expr);
                                                        }
                                                        formulas.push(`${formulaName} = ${calculation}`);
                                                    }
                                                }
                                                catch (e) {
                                                    formulas.push(`${selectItem.name} = [Complex Calculation]`);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        catch (e) {
                            // Ignore configuration parsing errors for individual visuals
                        }
                    }
                    // Normalize visual types (e.g. barChart, pieChart, table)
                    visualType = visualType.toLowerCase();
                    visuals.push({
                        name: visualName,
                        type: visualType,
                        columns: Array.from(new Set(columns)),
                        formulas: Array.from(new Set(formulas)),
                    });
                    visualTypesCount[visualType] = (visualTypesCount[visualType] || 0) + 1;
                    totalVisuals++;
                }
            }
            pages.push({
                name: pageName,
                displayName: pageDisplayName,
                visuals,
            });
        }
    }
    return {
        fileName,
        fileSizeMb,
        pages,
        summary: {
            totalPages: pages.length,
            totalVisuals,
            visualTypesCount,
        },
    };
}
