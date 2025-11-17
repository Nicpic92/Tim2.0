// --- DATA KEYS & HARDCODED HEADERS ---
const USER_HEADERS = [
    'Payer', 'Category', 'Claim Number', 'Type', 'Received Date',
    'Billing Provider Name', 'Billing Provider Tax ID', 'Billing Provider NPI',
    'Claim State', 'Claim Status', 'Patient', 'Subs Id', 'Rendering Provider Name',
    'Rendering Provider NPI', 'DOSFromDate', 'DOSToDate', 'Clean Age', 'Age',
    'TotalCharges', 'TotalNetPaymentAmt', 'NetworkStatus', 'PBP Name', 'Plan Name',
    'DSNP or Non DSNP', 'Claim Edits', 'Claim Notes', 'Activity Logger Description',
    'Activity Performed By', 'Activity Performed On'
];

const STANDARD_KEYS = USER_HEADERS.map(label => ({
    key: label,
    label: label,
    required: true,
}));

const HARDCODED_HEADERS = USER_HEADERS;

// --- GLOBAL DATA STORE (REPLACES POSTGRES DB) ---
var dataStore = {
    teams: [],
    categories: [],
    configs: [],
    claim_edit_rules: [],
    claim_note_rules: [],
    client_team_associations: [],
    team_report_configurations: [],
};
var nextIds = { teams: 1, categories: 1, configs: 1, associations: 1 };

const STORAGE_KEY = 'claimsDashboardData';

// --- GLOBAL APP STATE ---
var currentClaimsData = [];
var currentMetrics = null;
var selectedConfigId = '';

var ruleDiscoveryState = {
    selectedConfigId: '',
    isProcessingFile: false,
    isSaving: false,
    existingEditRules: new Set(),
    existingNoteRules: new Set(),
    uncategorizedEdits: [],
    uncategorizedNotes: [],
};

var associationManager = {
    selectedConfigId: '',
    associatedTeamIds: new Set(),
    isLoading: false,
    isSaving: false,
};


function loadDataStore() {
    const storedData = localStorage.getItem(STORAGE_KEY);
    if (storedData) {
        dataStore = JSON.parse(storedData);
        dataStore.client_team_associations = dataStore.client_team_associations || [];
        
        ['teams', 'categories', 'configs', 'associations'].forEach(key => {
            const list = dataStore[key] || [];
            nextIds[key] = list.length > 0 ? Math.max(...list.map(item => item.id)) + 1 : 1;
        });
    }
    console.log("Data Store Loaded: Object", dataStore);
}

function saveDataStore() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dataStore));
    console.log("Data Store Saved.");
}

// --- CLAIM SERVICE (BUSINESS LOGIC) ---

const fileService = {
    parseXlsxFile: (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = new Uint8Array(e.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    const sheet = workbook.Sheets[workbook.SheetNames[0]];

                    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0 });
                    if (!rawData || rawData.length === 0 || !rawData[0]) {
                        return reject(new Error("File is empty or contains no readable data."));
                    }
                    
                    const cleanHeaders = rawData[0]
                        .map(h => (h != null ? String(h).trim() : null))
                        .filter(h => h && h.length > 0);

                    if (cleanHeaders.length === 0) {
                        return reject(new Error("Could not detect any valid column headers in the first row."));
                    }
                    
                    const processedData = XLSX.utils.sheet_to_json(sheet, {
                        header: cleanHeaders,
                        range: 1
                    });
                    
                    resolve(processedData);
                } catch (err) {
                    reject(new Error("Failed to parse the XLSX file."));
                }
            };
            reader.onerror = (err) => reject(new Error("An error occurred while reading the file."));
            reader.readAsArrayBuffer(file);
        });
    }
};

const claimService = {
    getVal: (rawClaim, standardKey, mappings) => {
        const mappedKey = mappings[standardKey];
        return mappedKey && rawClaim[mappedKey] !== undefined ? rawClaim[mappedKey] : undefined;
    },

    calculatePriorityScore: (claim, mappings) => {
        const totalCharges = parseFloat(claimService.getVal(claim.original, 'TotalCharges', mappings) || 0);
        const age = parseInt(claim.age || 0, 10);
        let score = (totalCharges / 500) + (age * 1.5);
        if (claim.status === 'DENY') {
            score += 100;
        }
        return Math.round(score);
    },

    getClaimCategory: (rawClaim, mappings, editRulesMap, sortedNoteRules) => {
        const notes = (claimService.getVal(rawClaim, 'Claim Notes', mappings) || '').toLowerCase();
        const edit = claimService.getVal(rawClaim, 'Claim Edits', mappings);

        if (edit && editRulesMap.has(edit)) {
            return { ...editRulesMap.get(edit), category: editRulesMap.get(edit).category_name, source: 'Edit Rule' };
        }

        if (notes) {
            for (const [keyword, rule] of sortedNoteRules) {
                if (notes.includes(keyword)) {
                    return { ...rule, category: rule.category_name, source: 'Note Rule' };
                }
            }
        }

        return { category: 'Needs Triage', source: 'Default', team_name: 'Needs Assignment', send_to_l1_monitor: false };
    },

    analyzeAndProcessClaims: (rawData, mappings, clientRules) => {
        const metrics = { totalClaims: 0, totalNetPayment: 0, claimsByStatus: {} };
        const actionableStates = ['PEND', 'ONHOLD', 'MANAGEMENTREVIEW'];

        const editRulesMap = new Map(clientRules.editRules.map(r => [r.text, r]));
        const sortedNoteRules = clientRules.noteRules
            .map(r => [r.text.toLowerCase(), r])
            .sort((a, b) => b[0].length - a[0].length);

        const claims = rawData.map(rawClaim => {
            const processedClaim = {
                claimId: claimService.getVal(rawClaim, 'Claim Number', mappings) || 'N/A',
                state: String(claimService.getVal(rawClaim, 'Claim State', mappings) || 'UNKNOWN').toUpperCase().trim(),
                status: String(claimService.getVal(rawClaim, 'Claim Status', mappings) || 'UNKNOWN').toUpperCase().trim(),
                age: parseInt(claimService.getVal(rawClaim, 'Age', mappings) || 0, 10),
                netPayment: parseFloat(claimService.getVal(rawClaim, 'TotalNetPaymentAmt', mappings) || 0),
                providerName: claimService.getVal(rawClaim, 'Billing Provider Name', mappings) || 'Unknown',
                original: rawClaim,
            };

            metrics.totalClaims++;
            if (!isNaN(processedClaim.netPayment)) {
                metrics.totalNetPayment += processedClaim.netPayment;
            }
            metrics.claimsByStatus[processedClaim.status] = (metrics.claimsByStatus[processedClaim.status] || 0) + 1;
            
            processedClaim.isActionable = actionableStates.includes(processedClaim.state);
            
            if (processedClaim.isActionable) {
                const categoryInfo = claimService.getClaimCategory(rawClaim, mappings, editRulesMap, sortedNoteRules);
                Object.assign(processedClaim, categoryInfo);
                processedClaim.priorityScore = claimService.calculatePriorityScore(processedClaim, mappings);
            } else {
                processedClaim.category = 'N/A';
                processedClaim.team_name = 'N/A';
                processedClaim.priorityScore = -1;
            }
            
            return processedClaim;
        });

        return { claims, metrics };
    }
};

// --- API SERVICE (MOCKING DATABASE ACCESS WITH LOCALSTORAGE) ---

const apiService = {
    notify: (message, type = 'success') => {
        const toastDiv = document.createElement('div');
        toastDiv.className = `alert alert-${type} mt-3 fixed-bottom mx-auto w-50`;
        toastDiv.style.zIndex = 1050;
        toastDiv.innerText = message;
        document.body.appendChild(toastDiv);
        setTimeout(() => toastDiv.remove(), 4000);
    },

    // --- Generic Fetch Functions (GET) ---
    getTeams: () => Promise.resolve(dataStore.teams),
    getCategories: () => {
        const categories = dataStore.categories.map(cat => {
            const team = dataStore.teams.find(t => t.id === cat.team_id);
            // FIXED: Ensure team_name is correctly injected into the category object
            return { ...cat, team_name: team ? team.team_name : 'Unassigned' };
        }).sort((a, b) => a.category_name.localeCompare(b.category_name));
        return Promise.resolve(categories);
    },
    getConfigs: () => Promise.resolve(dataStore.configs),
    getTeamReportConfigs: () => Promise.resolve(dataStore.team_report_configurations),
    getRules: (type, configId) => {
        const rules = type === 'edit' ? dataStore.claim_edit_rules : dataStore.claim_note_rules;
        const filteredRules = rules
            .filter(r => r.config_id == configId)
            .map(r => {
                const category = dataStore.categories.find(c => c.id === r.category_id);
                const team = category ? dataStore.teams.find(t => t.id === category.team_id) : {};
                return {
                    text: type === 'edit' ? r.edit_text : r.note_keyword,
                    category_id: r.category_id,
                    category_name: category ? category.category_name : 'Unknown',
                    team_name: team.team_name || 'Unknown',
                };
            });
        return Promise.resolve(filteredRules);
    },
    
    getClientTeamAssociations: (configId) => {
        const associations = dataStore.client_team_associations
            .filter(a => a.config_id == configId)
            .map(a => a.team_id);
        return Promise.resolve(associations);
    },
    
    saveClientTeamAssociations: (payload) => {
        const { config_id, team_ids } = payload;

        dataStore.client_team_associations = dataStore.client_team_associations.filter(
            a => a.config_id != config_id
        );
        
        team_ids.forEach(team_id => {
            dataStore.client_team_associations.push({
                id: nextIds.associations++,
                config_id: parseInt(config_id, 10),
                team_id: parseInt(team_id, 10),
            });
        });

        saveDataStore();
        return Promise.resolve({ message: 'Associations saved.' });
    },

    // --- CRUD Operations ---
    createTeam: (teamData) => {
        const newTeam = { ...teamData, id: nextIds.teams++ };
        dataStore.teams.push(newTeam);
        saveDataStore();
        return Promise.resolve(newTeam);
    },
    deleteTeam: (id) => {
        dataStore.teams = dataStore.teams.filter(t => t.id != id);
        dataStore.categories.forEach(cat => { if (cat.team_id == id) cat.team_id = null; });
        dataStore.client_team_associations = dataStore.client_team_associations.filter(a => a.team_id != id);
        saveDataStore();
        return Promise.resolve();
    },
    createCategory: (categoryData) => {
        const newCategory = { ...categoryData, id: nextIds.categories++ };
        dataStore.categories.push(newCategory);
        saveDataStore();
        return Promise.resolve(newCategory);
    },
    
    updateCategory: (id, categoryData) => {
        const index = dataStore.categories.findIndex(c => c.id == id);
        if (index !== -1) {
            dataStore.categories[index] = { ...dataStore.categories[index], ...categoryData };
            saveDataStore();
            return Promise.resolve(dataStore.categories[index]);
        }
        return Promise.reject(new Error("Category not found"));
    },

    deleteCategory: (id) => {
        dataStore.categories = dataStore.categories.filter(c => c.id != id);
        dataStore.claim_edit_rules = dataStore.claim_edit_rules.filter(r => r.category_id != id);
        dataStore.claim_note_rules = dataStore.claim_note_rules.filter(r => r.category_id != id);
        saveDataStore();
        return Promise.resolve();
    },
    createConfig: (configData) => {
        const newConfig = { ...configData, id: nextIds.configs++ };
        dataStore.configs.push(newConfig);
        saveDataStore();
        return Promise.resolve(newConfig);
    },
    updateConfig: (id, configData) => {
        const index = dataStore.configs.findIndex(c => c.id == id);
        if (index !== -1) {
            dataStore.configs[index] = { ...dataStore.configs[index], ...configData };
            saveDataStore();
            return Promise.resolve(dataStore.configs[index]);
        }
        return Promise.reject(new Error("Config not found"));
    },
    deleteConfig: (id) => {
        dataStore.configs = dataStore.configs.filter(c => c.id != id);
        dataStore.claim_edit_rules = dataStore.claim_edit_rules.filter(r => r.config_id != id);
        dataStore.claim_note_rules = dataStore.claim_note_rules.filter(r => r.config_id != id);
        dataStore.client_team_associations = dataStore.client_team_associations.filter(a => a.config_id != id);
        saveDataStore();
        return Promise.resolve();
    },
    saveRules: (type, configId, rules) => {
        const ruleKey = type === 'edit' ? 'claim_edit_rules' : 'claim_note_rules';
        const textField = type === 'edit' ? 'edit_text' : 'note_keyword';
        const currentRules = dataStore[ruleKey];
        
        rules.forEach(newRule => {
            const existingIndex = currentRules.findIndex(r =>
                r.config_id == configId && (r.edit_text === newRule.text || r.note_keyword === newRule.text)
            );
            
            if (existingIndex !== -1) {
                currentRules[existingIndex].category_id = newRule.category_id;
            } else {
                currentRules.push({
                    config_id: parseInt(configId),
                    category_id: newRule.category_id,
                    [textField]: newRule.text,
                });
            }
        });
        dataStore[ruleKey] = currentRules;
        saveDataStore();
        return Promise.resolve();
    },
    deleteRule: (type, configId, ruleText) => {
        const ruleKey = type === 'edit' ? 'claim_edit_rules' : 'claim_note_rules';
        dataStore[ruleKey] = dataStore[ruleKey].filter(r =>
            !(r.config_id == configId && (r.edit_text === ruleText || r.note_keyword === ruleText))
        );
        saveDataStore();
        return Promise.resolve();
    },
    createTeamReportConfig: (reportData) => {
        const newConfig = { ...reportData, id: nextIds.configs++ };
        dataStore.team_report_configurations.push(newConfig);
        saveDataStore();
        return Promise.resolve(newConfig);
    },
    updateTeamReportConfig: (id, reportData) => {
        const index = dataStore.team_report_configurations.findIndex(c => c.id == id);
        if (index !== -1) {
            dataStore.team_report_configurations[index] = { ...dataStore.team_report_configurations[index], ...reportData };
            saveDataStore();
            return Promise.resolve(dataStore.team_report_configurations[index]);
        }
        return Promise.reject(new Error("Report Config not found"));
    },
};

// --- NAVIGATION AND ROUTING ---
var currentClaimsData = [];
var currentMetrics = null;
var selectedConfigId = '';

function navigate(path) {
    window.location.hash = path;
}

function loadConfigForEdit(config) {
    document.querySelector('#client-config-manager-area').innerHTML = renderClientConfigManager(dataStore.configs);
    document.querySelector('#client-config-manager-area .col-lg-7').innerHTML = renderConfigForm(config);
    document.querySelector('#client-config-manager-area').scrollIntoView();
}

function handleEditConfigClick(configId) {
    const config = dataStore.configs.find(c => c.id == configId);
    if (config) {
        loadConfigForEdit(config);
    } else {
        apiService.notify("Configuration not found.", 'danger');
    }
}

window.addEventListener('hashchange', renderApp);
window.addEventListener('DOMContentLoaded', () => {
    loadDataStore();
    renderApp();
});

// --- ADMIN HELPERS & LOGIC ---

async function handleAssociationSelection(selectElement) {
    const configId = selectElement.value;
    associationManager.selectedConfigId = configId;
    associationManager.associatedTeamIds.clear();
    associationManager.isLoading = true;
    renderAdminPage(document.getElementById('content-area'));

    try {
        if (configId) {
            const teamIds = await apiService.getClientTeamAssociations(configId);
            associationManager.associatedTeamIds = new Set(teamIds.map(String));
        }
    } catch (error) {
        apiService.notify(error.message || 'Failed to load associations.', 'danger');
    } finally {
        associationManager.isLoading = false;
        renderAdminPage(document.getElementById('content-area'));
    }
}

function handleCheckboxChange(teamId, isChecked) {
    const idString = String(teamId);
    if (isChecked) {
        associationManager.associatedTeamIds.add(idString);
    } else {
        associationManager.associatedTeamIds.delete(idString);
    }
}

async function handleAssociationSave() {
    const { selectedConfigId, associatedTeamIds } = associationManager;
    
    if (!selectedConfigId) {
        return apiService.notify('Please select a client first.', 'warning');
    }

    associationManager.isSaving = true;
    renderAdminPage(document.getElementById('content-area'));
    const toastId = apiService.notify('Saving associations...', 'info');

    try {
        const payload = {
            config_id: parseInt(selectedConfigId, 10),
            team_ids: Array.from(associatedTeamIds).map(Number)
        };
        await apiService.saveClientTeamAssociations(payload);
        apiService.notify('Associations saved successfully!', 'success');
    } catch (error) {
        apiService.notify(error.message || 'Failed to save associations.', 'danger');
    } finally {
        associationManager.isSaving = false;
        // The original code tried to dismiss a toast with a placeholder ID, removing that call to prevent errors.
        renderAdminPage(document.getElementById('content-area'));
    }
}

function activateTab(button) {
    const tabList = button.closest('.nav-tabs');
    tabList.querySelectorAll('.nav-link').forEach(btn => btn.classList.remove('active'));

    const contentArea = tabList.closest('.card').querySelector('.tab-content');
    contentArea.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.remove('active', 'show');
    });

    button.classList.add('active');

    const targetId = button.getAttribute('data-bs-target');
    const targetPane = document.querySelector(targetId);
    if (targetPane) {
        targetPane.classList.add('active', 'show');
        // FIXED: Force re-render of Rule Discovery content when activated
        if (targetId === '#discover-pane') {
            renderRuleDiscoveryManager(dataStore.configs, dataStore.categories, true);
        }
    }
}

function handleDiscoverySelectionChange(configId) {
    ruleDiscoveryState.selectedConfigId = configId;
    ruleDiscoveryState.uncategorizedEdits = [];
    ruleDiscoveryState.uncategorizedNotes = [];

    apiService.getRules('edit', configId)
        .then(editRules => {
            ruleDiscoveryState.existingEditRules = new Set(editRules.map(r => r.text));
            return apiService.getRules('note', configId);
        })
        .then(noteRules => {
            ruleDiscoveryState.existingNoteRules = new Set(noteRules.map(r => r.text));
            renderRuleDiscoveryManager(dataStore.configs, dataStore.categories, true);
        })
        .catch(error => {
            apiService.notify('Failed to load existing rules.', 'danger');
            renderRuleDiscoveryManager(dataStore.configs, dataStore.categories, true);
        });
    renderRuleDiscoveryManager(dataStore.configs, dataStore.categories, true);
}

async function handleProcessDiscoveryFile(file) {
    if (!ruleDiscoveryState.selectedConfigId) return apiService.notify('Please select a client first.', 'warning');
    if (!file) return;

    ruleDiscoveryState.isProcessingFile = true;
    renderRuleDiscoveryManager(dataStore.configs, dataStore.categories, true);
    const toastId = apiService.notify('Analyzing report for new rules...', 'info');

    try {
        const data = await fileService.parseXlsxFile(file);
        const selectedConfig = dataStore.configs.find(c => c.id == ruleDiscoveryState.selectedConfigId);
        const mappings = selectedConfig.config_data.columnMappings;

        const editCol = mappings['Claim Edits'];
        const notesCol = mappings['Claim Notes'];
        
        const newEdits = new Set();
        const newNotes = new Set();

        data.forEach(row => {
            const editValue = row[editCol] ? String(row[editCol]).trim() : '';
            if (editValue && !ruleDiscoveryState.existingEditRules.has(editValue)) {
                newEdits.add(editValue);
            }

            const noteValue = row[notesCol] ? String(row[notesCol]).trim() : '';
            if (noteValue && !ruleDiscoveryState.existingNoteRules.has(noteValue)) {
                newNotes.add(noteValue);
            }
        });

        ruleDiscoveryState.uncategorizedEdits = Array.from(newEdits).sort().map(text => ({ text, category_id: '' }));
        ruleDiscoveryState.uncategorizedNotes = Array.from(newNotes).sort().map(text => ({ text, category_id: '' }));
        
        if (newEdits.size === 0 && newNotes.size === 0) {
            apiService.notify('File processed. No new, uncategorized items were found.', 'success');
        } else {
            apiService.notify(`Found ${newEdits.size} new edits and ${newNotes.size} new notes.`, 'success');
        }

    } catch (error) {
        apiService.notify(error.message || 'Failed to process file.', 'danger');
    } finally {
        ruleDiscoveryState.isProcessingFile = false;
        // The original code tried to dismiss a toast with a placeholder ID, removing that call to prevent errors.
        renderRuleDiscoveryManager(dataStore.configs, dataStore.categories, true);
    }
}

function handleAssignCategoryChange(type, index, categoryId) {
    const list = type === 'edits' ? ruleDiscoveryState.uncategorizedEdits : ruleDiscoveryState.uncategorizedNotes;
    list[index].category_id = categoryId;
}

async function handleSaveNewRules() {
    const { selectedConfigId, uncategorizedEdits, uncategorizedNotes } = ruleDiscoveryState;

    const editsToSave = uncategorizedEdits
        .filter(item => item.category_id)
        .map(item => ({ text: item.text, category_id: parseInt(item.category_id, 10) }));

    const notesToSave = uncategorizedNotes
        .filter(item => item.category_id)
        .map(item => ({ text: item.text, category_id: parseInt(item.category_id, 10) }));

    if (editsToSave.length === 0 && notesToSave.length === 0) {
        return apiService.notify('No rules have been assigned to a category.', 'warning');
    }

    ruleDiscoveryState.isSaving = true;
    renderRuleDiscoveryManager(dataStore.configs, dataStore.categories, true);
    const toastId = apiService.notify('Saving new rules...', 'info');

    try {
        const promises = [];
        if (editsToSave.length > 0) {
            promises.push(apiService.saveRules('edit', selectedConfigId, editsToSave));
        }
        if (notesToSave.length > 0) {
            promises.push(apiService.saveRules('note', selectedConfigId, notesToSave));
        }
        await Promise.all(promises);

        apiService.notify('New rules saved successfully!', 'success');
        ruleDiscoveryState.uncategorizedEdits = [];
        ruleDiscoveryState.uncategorizedNotes = [];
        renderAdminPage(document.getElementById('content-area'));

    } catch (error) {
        apiService.notify(error.message || 'Failed to save rules.', 'danger');
    } finally {
        ruleDiscoveryState.isSaving = false;
        // The original code tried to dismiss a toast with a placeholder ID, removing that call to prevent errors.
        renderRuleDiscoveryManager(dataStore.configs, dataStore.categories, true);
    }
}

// Global function required for inline 'onchange' handler in HTML template
async function handleCategoryTeamUpdate(categoryId, newTeamId) {
    try {
        const teamId = newTeamId ? parseInt(newTeamId, 10) : null;
        await apiService.updateCategory(categoryId, { team_id: teamId });
        apiService.notify('Category team updated successfully!', 'success');
        // Re-render the admin page to update the Category Manager UI
        await renderAdminPage(document.getElementById('content-area'));
    } catch (error) {
        apiService.notify(error.message || 'Failed to update category team.', 'danger');
    }
}


// --- PAGE RENDERERS ---

function renderRuleDiscoveryManager(configs, categories, isPartialRender = false) {
    const { selectedConfigId, isProcessingFile, isSaving, uncategorizedEdits, uncategorizedNotes } = ruleDiscoveryState;
    const selectedConfig = configs.find(c => c.id == selectedConfigId);
    const hasUncategorizedItems = uncategorizedEdits.length > 0 || uncategorizedNotes.length > 0;
    
    const canUpload = selectedConfig && selectedConfig.config_data.columnMappings['Claim Edits'] && selectedConfig.config_data.columnMappings['Claim Notes'];

    // NOTE: We must refetch categories and configs on partial render to ensure dropdowns are correct.
    if (isPartialRender) {
        Promise.all([apiService.getConfigs(), apiService.getCategories()])
            .then(([newConfigs, newCategories]) => {
                _renderRuleDiscoveryUI(newConfigs, newCategories);
            });
        
        // Show a loading state briefly during fetch
        const container = document.querySelector('#discover-pane');
        if (container) container.innerHTML = '<div class="text-center p-5"><div class="spinner-border text-primary loading-spinner-sm" role="status"></div> Updating Data...</div>';
        
        // If this is just called for the full admin render, we return the placeholder
        return '';
    } else {
        return _renderRuleDiscoveryUI(configs, categories);
    }
}

function _renderRuleDiscoveryUI(configs, categories) {
    const { selectedConfigId, isProcessingFile, isSaving, uncategorizedEdits, uncategorizedNotes } = ruleDiscoveryState;
    const selectedConfig = configs.find(c => c.id == selectedConfigId);
    const hasUncategorizedItems = uncategorizedEdits.length > 0 || uncategorizedNotes.length > 0;
    
    const canUpload = selectedConfig && selectedConfig.config_data.columnMappings['Claim Edits'] && selectedConfig.config_data.columnMappings['Claim Notes'];

    const html = `
        <div class="config-form-container">
            <h5>Rule Discovery & Assignment</h5>
            <p class="text-muted">Discover uncategorized edits/notes from a claims file and assign them to a category.</p>

            <div class="row bg-light p-3 rounded mb-3 align-items-end">
                <div class="col-md-6">
                    <label class="form-label fw-bold">1. Select Client</label>
                    <select id="discoveryClientSelector" class="form-select" ${isProcessingFile || isSaving ? 'disabled' : ''}>
                        <option value="">Select a client...</option>
                        ${configs.map(config => `<option value="${config.id}" ${config.id == selectedConfigId ? 'selected' : ''}>${config.config_name}</option>`).join('')}
                    </select>
                </div>
                <div class="col-md-6">
                    <label class="form-label fw-bold">2. Upload Report to Discover Rules</label>
                    <input
                        id="discoveryFileInput"
                        class="form-control"
                        type="file"
                        accept=".xlsx"
                        ${!selectedConfigId || !canUpload || isProcessingFile || isSaving ? 'disabled' : ''}
                    />
                    ${selectedConfigId && !canUpload ? `
                        <small class="text-danger">This config must map "Claim Edits" and "Claim Notes".</small>
                    ` : ''}
                </div>
            </div>

            ${isProcessingFile ? `
                <div class="text-center p-5"><div class="spinner-border text-primary loading-spinner-sm" role="status"></div> Loading...</div>
            ` : hasUncategorizedItems ? `
                <div>
                    <button id="saveNewRulesButton" class="btn btn-success mb-3" ${isSaving ? 'disabled' : ''}>
                        ${isSaving ? `<div class="spinner-border text-light spinner-border-sm loading-spinner-sm" role="status"></div> Saving...` : 'Save All Rule Assignments'}
                    </button>
                    
                    ${renderUncategorizedRulesTable("Uncategorized Claim Edits", uncategorizedEdits, categories, 'edits')}
                    ${renderUncategorizedRulesTable("Uncategorized Claim Notes", uncategorizedNotes, categories, 'notes', 'mt-4')}
                </div>
            ` : `
                <div class="alert alert-info">
                    ${selectedConfigId ? 'Upload a file to begin the discovery process.' : 'Select a client to begin.'}
                </div>
            `}
        </div>
    `;
    
    const container = document.querySelector('#discover-pane');
    if (container) {
        container.innerHTML = html;

        container.querySelector('#discoveryClientSelector')?.addEventListener('change', (e) => {
            handleDiscoverySelectionChange(e.target.value);
        });
        container.querySelector('#discoveryFileInput')?.addEventListener('change', (e) => {
            handleProcessDiscoveryFile(e.target.files[0]);
        });
        container.querySelector('#saveNewRulesButton')?.addEventListener('click', handleSaveNewRules);

        container.querySelectorAll('.category-assignment-select').forEach(select => {
            select.addEventListener('change', (e) => {
                const [type, index] = e.target.dataset.rule.split('-');
                handleAssignCategoryChange(type, index, e.target.value);
            });
        });
    }
    return html;
}

function renderUncategorizedRulesTable(title, items, categories, type, className = '') {
    if (items.length === 0) return '';

    const groupedCategories = categories.reduce((acc, cat) => {
        const teamName = cat.team_name || 'Unassigned';
        (acc[teamName] = acc[teamName] || []).push(cat);
        return acc;
    }, {});

    const tableRows = items.map((item, index) => `
        <tr key="${index}">
            <td style="max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                <span title="${item.text}">${item.text}</span>
            </td>
            <td>
                <select
                    class="form-select form-select-sm category-assignment-select"
                    data-rule="${type}-${index}"
                    value="${item.category_id}"
                >
                    <option value="">Select a category...</option>
                    ${Object.keys(groupedCategories).sort().map(teamName => `
                        <optgroup label="${teamName}">
                            ${groupedCategories[teamName].map(cat => `
                                <option value="${cat.id}">
                                    ${cat.category_name}
                                </option>
                            `).join('')}
                        </optgroup>
                    `).join('')}
                </select>
            </td>
        </tr>
    `).join('');

    return `
        <div class="${className}">
            <h6>${title} (${items.length})</h6>
            <div class="table-responsive-sm discovery-table-container">
                <table class="table table-sm table-bordered">
                    <thead class="table-light">
                        <tr>
                            <th>Item Text</th>
                            <th>Assign to Category</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function renderRuleManager(configs, categories) {
    return `
        <div class="config-form-container">
            <h5>Manage Existing Categorization Rules</h5>
            <p class="text-muted">Select a Configuration (Client) to view and edit its Edit and Note rules.</p>
            
            <div class="mb-3">
                <label for="clientRuleFilter" class="form-label">Filter by Client</label>
                <select id="clientRuleFilter" class="form-select form-select-sm">
                    <option value="">Select a Client...</option>
                    ${configs.map(c => `<option value="${c.id}">${c.config_name}</option>`).join('')}
                </select>
            </div>

            <div class="alert alert-warning">
                Rule display and editing is a placeholder. Functionality for fetching/deleting rules is available in the data store.
            </div>
        </div>
    `;
}


function renderApp() {
    const path = window.location.hash.slice(1) || 'dashboard';
    const root = document.getElementById('app-root');
    root.innerHTML = '';
    
    const mainLayout = renderMainLayout();
    root.appendChild(mainLayout);
    const contentArea = document.getElementById('content-area');

    if (path.startsWith('admin')) {
        renderAdminPage(contentArea);
    } else if (path.startsWith('reports')) {
        renderReportsPage(contentArea);
    } else {
        renderDashboardPage(contentArea);
    }
}

function renderMainLayout() {
    const div = document.createElement('div');
    div.innerHTML = `
        <header class="mb-4 d-flex justify-content-between align-items-center">
            <div>
                <img src="./logo.png" onerror="this.style.display='none'" alt="Mirra Logo" style="height: 24px; margin-bottom: 10px;">
                <h1 class="display-6 claims-header">Claims Dashboard & Analytics</h1>
            </div>
            <nav>
                <a href="#dashboard" class="btn btn-outline-primary me-2">Dashboard</a>
                <a href="#admin" class="btn btn-outline-secondary me-2">Admin Console</a>
                <a href="#reports" class="btn btn-outline-info">Report Builder</a>
            </nav>
        </header>
        <main id="content-area" class="main-content">
            </main>
    `;
    return div;
}

async function renderDashboardPage(container) {
    const configs = await apiService.getConfigs();
    var isProcessing = false;

    const handleConfigChange = async (id) => {
        selectedConfigId = id;
        const selectedConfig = configs.find(c => c.id == id);
        if (selectedConfig) {
            const [editRules, noteRules] = await Promise.all([
                apiService.getRules('edit', id),
                apiService.getRules('note', id)
            ]);
            selectedConfig.clientRules = { editRules, noteRules };
        }
        renderDashboardPage(container);
    };

    const handleProcessFile = async (file) => {
        if (!file) return;

        const selectedConfig = configs.find(c => c.id == selectedConfigId);
        if (!selectedConfig) return apiService.notify("Cannot process file without a selected client configuration.", 'danger');

        isProcessing = true;
        renderDashboardPage(container);
        apiService.notify(`Analyzing file...`, 'info');

        try {
            const rawData = await fileService.parseXlsxFile(file);
            
            const { claims, metrics: newMetrics } = claimService.analyzeAndProcessClaims(
                rawData,
                selectedConfig.config_data.columnMappings,
                selectedConfig.clientRules
            );

            currentClaimsData = claims;
            currentMetrics = newMetrics;
            apiService.notify('Analysis complete!', 'success');
        } catch (error) {
            apiService.notify(error.message || "An error occurred during claims analysis.", 'danger');
        } finally {
            isProcessing = false;
            renderDashboardPage(container);
        }
    };
    
    container.innerHTML = `
        <div class="row">
            <div class="col-12">
                <h1 class="mb-4">Dashboard</h1>
                ${renderDashboardControlPanel(configs, selectedConfigId, handleConfigChange, handleProcessFile, isProcessing)}
                ${isProcessing ? `
                    <div class="text-center">
                        <div class="spinner-border text-primary" role="status"></div>
                        <p>Processing...</p>
                    </div>
                ` : currentClaimsData.length > 0 ? renderWorkQueueTable(currentClaimsData) : `
                    <div class="mt-4 text-center">
                        <div class="alert alert-light">Please select a configuration and upload a claims report to begin.</div>
                    </div>
                `}
            </div>
        </div>
    `;
    
    const configSelector = container.querySelector('#configSelector');
    if (configSelector) {
        configSelector.addEventListener('change', (e) => handleConfigChange(e.target.value));
    }
    const fileInput = container.querySelector('#reportFile');
    if (fileInput) {
        fileInput.addEventListener('change', (e) => handleProcessFile(e.target.files[0]));
    }
}

function renderDashboardControlPanel(configs, selectedConfigId, onConfigChange, onProcessFile, isProcessing) {
    const selectedConfig = configs.find(c => c.id == selectedConfigId);
    const clientName = selectedConfig?.config_name || '';

    return `
        <div class="card p-3 mb-4">
            <h5 class="card-title fw-bold">1. Report Options</h5>
            <div class="row align-items-end">
                <div class="col-md-6 mb-3">
                    <label for="configSelector" class="form-label small fw-bold">Select Report Configuration</label>
                    <select id="configSelector" class="form-select" value="${selectedConfigId}" ${isProcessing ? 'disabled' : ''}>
                        <option value="">Select a configuration...</option>
                        ${configs.map(config => `<option value="${config.id}" ${config.id == selectedConfigId ? 'selected' : ''}>${config.config_name}</option>`).join('')}
                    </select>
                </div>
                <div class="col-md-6 mb-3">
                    <label for="clientName" class="form-label small fw-bold">Client Name</label>
                    <input type="text" id="clientName" class="form-control" value="${clientName}" readonly placeholder="Select a configuration">
                </div>
            </div>
        </div>
        <div class="card p-3 mb-4 bg-light border-0">
            <h5 class="card-title fw-bold">2. Upload Claims Data</h5>
            <label for="reportFile" class="form-label">Select an XLSX file to begin analysis.</label>
            <input id="reportFile" class="form-control" type="file" accept=".xlsx" ${!selectedConfig || isProcessing ? 'disabled' : ''}>
        </div>
    `;
}

function renderWorkQueueTable(claimsData) {
    const actionableClaims = claimsData.filter(c => c.isActionable);
    const sortedAndFilteredClaims = actionableClaims.sort((a, b) => b.priorityScore - a.priorityScore);

    return `
        <div class="card p-3">
            <h5 class="card-title">Operational Work Queue</h5>
            <div class="table-responsive">
                <table class="table table-striped table-hover">
                    <thead class="table-primary-header">
                        <tr>
                            <th>Priority</th>
                            <th>Category</th>
                            <th>Assigned Team</th>
                            <th>Claim ID</th>
                            <th>Age</th>
                            <th>Amount at Risk</th>
                            <th>Billing Provider</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${sortedAndFilteredClaims.map(claim => `
                            <tr key="${claim.claimId}">
                                <td>${claim.priorityScore}</td>
                                <td>${claim.category}</td>
                                <td>${claim.team_name}</td>
                                <td>${claim.claimId}</td>
                                <td>${claim.age}</td>
                                <td>$${(claim.netPayment || 0).toFixed(2)}</td>
                                <td>${claim.providerName}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

async function renderAdminPage(container) {
    const [teams, categories, configs] = await Promise.all([
        apiService.getTeams(),
        apiService.getCategories(),
        apiService.getConfigs(),
    ]);

    container.innerHTML = `
        <h1 class="mb-4">Admin Console</h1>
        <div class="row g-5">
            <div class="col-12">
                <div id="client-config-manager-area"></div>
            </div>
        </div>
        <div class="row g-5 mt-4">
            <div class="col-12">
                <div class="card">
                    <div class="card-body">
                        <h2>Client-Specific Categorization & Team Management</h2>
                        <p class="text-muted">Manage teams and categories globally, then create rules for each client to automatically assign claims.</p>
                        <ul class="nav nav-tabs" role="tablist" id="ruleTabs">
                            <li class="nav-item"><button class="nav-link active" data-tab-name="setup" data-bs-target="#setup-pane" type="button">Setup</button></li>
                            <li class="nav-item"><button class="nav-link" data-tab-name="discover" data-bs-target="#discover-pane" type="button">Discover & Assign Rules</button></li>
                            <li class="nav-item"><button class="nav-link" data-tab-name="manage" data-bs-target="#manage-rules-pane" type="button">Manage Existing Rules</button></li>
                        </ul>
                        <div class="tab-content pt-3">
                            <div class="tab-pane fade show active" id="setup-pane">
                                <div class="row g-4">
                                    <div class="col-lg-4">${renderTeamManager(teams)}</div>
                                    <div class="col-lg-4">${renderCategoryManager(categories, teams)}</div>
                                    <div class="col-lg-4">${renderClientTeamAssociationManager(configs, teams)}</div>
                                </div>
                            </div>
                            <div class="tab-pane fade" id="discover-pane">${renderRuleDiscoveryManager(configs, categories)}</div>
                            <div class="tab-pane fade" id="manage-rules-pane">${renderRuleManager(configs, categories)}</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    container.querySelector('#client-config-manager-area').innerHTML = renderClientConfigManager(configs);
    
    container.querySelectorAll('#ruleTabs button[data-tab-name]').forEach(button => {
        button.addEventListener('click', (e) => {
            activateTab(e.currentTarget);
        });
    });

    container.querySelectorAll('button[data-action], form[data-form]').forEach(element => {
        if (element.tagName === 'FORM') {
            element.addEventListener('submit', (e) => {
                e.preventDefault();
                handleFormSubmit(e.target, renderAdminPage, container);
            });
        } else if (element.tagName === 'BUTTON' && element.dataset.action.startsWith('delete')) {
            element.addEventListener('click', (e) => {
                e.preventDefault();
                if (confirm('Are you sure you want to delete this item?')) {
                    handleDeleteAction(e.target.dataset.action, renderAdminPage, container);
                }
            });
        }
    });
    
    renderRuleDiscoveryManager(configs, categories, true);
}

async function handleFormSubmit(form, callback, container) {
    const formData = new FormData(form);
    const data = {};
    formData.forEach((value, key) => data[key] = value);
    
    const action = form.dataset.form;
    
    try {
        switch (action) {
            case 'addTeam':
                await apiService.createTeam({ team_name: data.team_name });
                apiService.notify('Team added!');
                break;
            case 'addCategory':
                await apiService.createCategory({
                    category_name: data.category_name,
                    team_id: parseInt(data.team_id, 10),
                    send_to_l1_monitor: data.send_to_l1_monitor === 'on'
                });
                apiService.notify('Category added!');
                break;
            case 'saveConfig':
                const columnMappings = {};
                STANDARD_KEYS.forEach(item => {
                    if (data[item.key]) {
                        columnMappings[item.key] = data[item.key];
                    }
                });

                const payload = {
                    config_name: data.config_name,
                    config_data: {
                        columnMappings: columnMappings,
                        clientName: data.config_name
                    }
                };
                
                if (data.id) {
                    await apiService.updateConfig(data.id, payload);
                    apiService.notify('Configuration updated!');
                } else {
                    await apiService.createConfig(payload);
                    apiService.notify('Configuration created!');
                }
                break;
        }
        callback(container);
    } catch (error) {
        apiService.notify(error.message || "Failed to perform action.", 'danger');
    }
}

async function handleDeleteAction(actionString, callback, container) {
    const [action, id] = actionString.split(':');
    try {
        switch (action) {
            case 'deleteTeam':
                await apiService.deleteTeam(id);
                apiService.notify('Team deleted!');
                break;
            case 'deleteCategory':
                await apiService.deleteCategory(id);
                apiService.notify('Category deleted!');
                break;
            case 'deleteConfig':
                await apiService.deleteConfig(id);
                apiService.notify('Configuration deleted!');
                break;
        }
        callback(container);
    } catch (error) {
        apiService.notify(error.message || "Failed to delete.", 'danger');
    }
}


function renderTeamManager(teams) {
    return `
        <div class="config-form-container">
            <h5>1. Manage Teams</h5>
            <ul class="list-group mb-3">
                ${teams.length > 0 ? teams.map(team => `
                    <li class="list-group-item py-1 d-flex justify-content-between align-items-center">
                        ${team.team_name}
                        <button data-action="deleteTeam:${team.id}" class="btn btn-outline-danger btn-sm py-0 px-1" style="line-height: 1;">&times;</button>
                    </li>
                `).join('') : '<li class="list-group-item">No teams defined yet.</li>'}
            </ul>
            <form data-form="addTeam" class="d-flex">
                <input type="text" name="team_name" class="form-control me-2" placeholder="New Team Name" required />
                <button type="submit" class="btn btn-primary btn-sm">Add</button>
            </form>
        </div>
    `;
}

function renderCategoryManager(categories, teams) {
    const groupedCategories = categories.reduce((acc, cat) => {
        const teamName = teams.find(t => t.id === cat.team_id)?.team_name || 'Unassigned';
        (acc[teamName] = acc[teamName] || []).push(cat);
        return acc;
    }, {});

    return `
        <div class="config-form-container">
            <h5>2. Manage Categories</h5>
            <form data-form="addCategory" class="mb-4">
                <div class="mb-2">
                    <select name="team_id" class="form-select" required>
                        <option value="">Select team to add to...</option>
                        ${teams.map(team => `<option value="${team.id}">${team.team_name}</option>`).join('')}
                    </select>
                </div>
                <div class="d-flex">
                    <input type="text" name="category_name" class="form-control me-2" placeholder="New Category Name" required />
                    <button type="submit" class="btn btn-primary btn-sm">Add</button>
                </div>
                <div class="form-check mt-2">
                    <input class="form-check-input" type="checkbox" name="send_to_l1_monitor">
                    <label class="form-check-label">Include in L1 Monitor Report</label>
                </div>
            </form>

            ${Object.keys(groupedCategories).sort().map(teamName => `
                <div class="card mb-2">
                    <div class="card-header py-1">${teamName}</div>
                    <ul class="list-group list-group-flush">
                        ${groupedCategories[teamName].map(cat => `
                            <li class="list-group-item py-1 d-flex justify-content-between align-items-center">
                                <div class="d-flex align-items-center flex-grow-1">
                                    <span class="me-3">
                                        ${cat.category_name}
                                        ${cat.send_to_l1_monitor ? '<span class="badge bg-info text-dark ms-2">L1 Monitor</span>' : ''}
                                    </span>
                                    <select
                                        class="form-select form-select-sm w-auto"
                                        onchange="handleCategoryTeamUpdate(${cat.id}, this.value)"
                                    >
                                        <option value="">Select team...</option>
                                        ${teams.map(team => `
                                            <option value="${team.id}" ${cat.team_id == team.id ? 'selected' : ''}>
                                                ${team.team_name}
                                            </option>
                                        `).join('')}
                                    </select>
                                </div>
                                <button data-action="deleteCategory:${cat.id}" class="btn btn-outline-danger btn-sm py-0 px-1 ms-2" style="line-height: 1;">&times;</button>
                            </li>
                        `).join('')}
                    </ul>
                </div>
            `).join('')}
        </div>
    `;
}

function renderClientTeamAssociationManager(configs, teams) {
    const { selectedConfigId, associatedTeamIds, isLoading, isSaving } = associationManager;
    
    const teamCheckboxes = teams.map(team => `
        <div key="${team.id}" class="form-check">
            <input
                class="form-check-input"
                type="checkbox"
                id="team_check_${team.id}"
                data-team-id="${team.id}"
                ${associatedTeamIds.has(String(team.id)) ? 'checked' : ''}
                ${!selectedConfigId || isLoading || isSaving ? 'disabled' : ''}
                onchange="handleCheckboxChange(${team.id}, this.checked)"
            >
            <label class="form-check-label" for="team_check_${team.id}">
                ${team.team_name}
            </label>
        </div>
    `).join('');

    return `
        <div class="config-form-container">
            <h5>3. Manage Client-Team Associations</h5>
            <div class="mb-3">
                <label for="clientTeamConfigSelector" class="form-label">Select Client</label>
                <select id="clientTeamConfigSelector" class="form-select" onchange="handleAssociationSelection(this)" ${isSaving || isLoading ? 'disabled' : ''}>
                    <option value="">Select a client...</option>
                    ${configs.map(config => `
                        <option value="${config.id}" ${config.id == selectedConfigId ? 'selected' : ''}>${config.config_name}</option>
                    `).join('')}
                </select>
            </div>
            <div class="mb-3">
                <label class="form-label">Select Associated Teams</label>
                <div id="teamCheckboxes" class="border rounded p-2" style="max-height: 200px; overflow-y: auto;">
                    ${isLoading ? `
                        <div class="text-center p-3"><div class="spinner-border text-primary loading-spinner-sm" role="status"></div> Loading...</div>
                    ` : !selectedConfigId ? `
                        <small class="text-muted">Select a client to see teams.</small>
                    ` : `
                        ${teamCheckboxes}
                    `}
                </div>
            </div>
            <button id="saveAssociationsButton" class="btn btn-success" onclick="handleAssociationSave()" ${isSaving || !selectedConfigId ? 'disabled' : ''}>
                ${isSaving ? `<div class="spinner-border text-light spinner-border-sm loading-spinner-sm" role="status"></div> Saving...` : 'Save Associations'}
            </button>
        </div>
    `;
}


function renderClientConfigManager(configs) {
    return `
        <div class="card">
            <div class="card-body">
                <h2>Client Configurations</h2>
                <p class="text-muted">Manage settings for individual clients and their column mappings.</p>
                <div class="row g-4">
                    <div class="col-lg-7">
                        ${renderConfigForm({})}
                    </div>
                    <div class="col-lg-5">
                        <h5>Existing Configurations</h5>
                        <p class="small text-muted">Click a name to edit.</p>
                        <ul class="list-group">
                            ${configs.map(config => `
                                <li class="list-group-item d-flex justify-content-between align-items-center">
                                    <a href="#" onclick="event.preventDefault(); handleEditConfigClick(${config.id});">${config.config_name}</a>
                                    <button data-action="deleteConfig:${config.id}" class="btn btn-danger btn-sm">Delete</button>
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function renderConfigForm(config) {
    const isEditing = !!config.id;
    const currentMappings = config.config_data?.columnMappings || {};
    
    const mappingRows = STANDARD_KEYS.map(item => `
        <tr>
            <td class="${item.required ? 'fw-bold' : ''}">${item.label}</td>
            <td>
                <select name="${item.key}" class="form-select form-select-sm" required>
                    <option value="">Select a header...</option>
                    ${HARDCODED_HEADERS.map(header => `
                        <option value="${header}" ${currentMappings[item.key] === header ? 'selected' : ''}>${header}</option>
                    `).join('')}
                </select>
            </td>
        </tr>
    `).join('');


    return `
        <div class="config-form-container">
            <legend>${isEditing ? 'Edit Configuration' : 'Create New Configuration'}</legend>
            <form data-form="saveConfig" id="config-form-${config.id || 'new'}">
                <input type="hidden" name="id" value="${config.id || ''}">
                
                <div class="mb-3">
                    <label for="config_name" class="form-label">Configuration Name</label>
                    <input type="text" name="config_name" class="form-control" value="${config.config_name || ''}" required placeholder="e.g., National Health Group">
                </div>

                <h5 class="mt-4">1. Discover Report Headers (Optional)</h5>
                <div class="alert alert-warning small py-2">
                    **${HARDCODED_HEADERS.length} Hardcoded Headers** loaded for mapping.
                </div>

                <h5 class="mt-4">2. Column Mapping</h5>
                <p class="text-muted small">Select the client's report headers to map to the standard system fields.</p>

                <div class="table-responsive mb-4">
                    <table class="table table-sm table-bordered">
                        <thead class="table-light">
                            <tr><th>Standard Key (System Field)</th><th>Source Column Name (Client Header)</th></tr>
                        </thead>
                        <tbody>
                            ${mappingRows}
                        </tbody>
                    </table>
                </div>
                
                <h5 class='mt-4'>3. PDF Report Builder (Coming Soon)</h5>
                <div class="alert alert-info"><i class="bi bi-info-circle-fill me-2"></i>PDF report builder sections will be added here.</div>

                <hr />
                
                <button type="submit" class="btn btn-primary">${isEditing ? 'Update Configuration' : 'Save Configuration'}</button>
                <button type="button" class="btn btn-secondary ms-2" onclick="renderApp()">Clear Form</button>
            </form>
        </div>
    `;
}


async function renderReportsPage(container) {
    const [teams, categories, reportConfigs] = await Promise.all([
        apiService.getTeams(),
        apiService.getCategories(),
        apiService.getTeamReportConfigs(),
    ]);

    container.innerHTML = `
        <h1 class="mb-4">Universal Report Builder</h1>
        <p>Report builder functionality is enabled here, but UI is for demonstration only in this offline mode.</p>
        <div class="alert alert-info">
            <strong>Total Report Configurations Saved:</strong> ${reportConfigs.length}
        </div>
    `;
}
