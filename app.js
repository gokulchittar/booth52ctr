// Firebase Config
const firebaseConfig = {
    apiKey: "AIzaSyD-A7lY6JLLXVrBwViQDcpJLw5PyIOOBHw",
    authDomain: "booth52114.firebaseapp.com",
    databaseURL: "https://booth52114-default-rtdb.firebaseio.com",
    projectId: "booth52114",
    storageBucket: "booth52114.firebasestorage.app",
    messagingSenderId: "327777612655",
    appId: "1:327777612655:web:b5b383a7cda12250abee9a"
};

firebase.initializeApp(firebaseConfig);
const rtdb = firebase.database();

// Options for dropdowns
const POLITICS_OPTIONS = ['Unknown', 'Neutral', 'LDF', 'UDF', 'NDA'];
const VOTE_TYPE_OPTIONS = ['Normal', 'Postal', 'Home vote'];
const LOCATION_OPTIONS = ['Chittar', 'Out of Panchayath', 'Out of District', 'Out of Kerala', 'Out of India'];
const RELIGION_OPTS = ['Unknown', 'Hindu', 'Christian', 'Muslim'];
const COMMUNITY_OPTS = {
    'Unknown': ['Unknown'],
    'Hindu': ['Unknown', 'Nair', 'Ezhava', 'Pulaya', 'Paraya', 'Vishwakarma', 'Vellalar'],
    'Christian': ['Unknown', 'Marthomite', 'Jacobite', 'Orthodox', 'MC (Malankara Catholic)', 'Syro-Malabar', 'Latin Catholic', 'CSI', 'Pentecostal'],
    'Muslim': ['Muslim']
};
const SQUADS = [1, 2, 3, 4, 5];

window.getCommunityOptions = function (rel, selectedComm) {
    const opts = COMMUNITY_OPTS[rel] || COMMUNITY_OPTS['Unknown'];
    return opts.map(o => `<option value="${o}" ${o === selectedComm ? 'selected' : ''}>${o}</option>`).join('');
};

window.handleReligionChange = function (sourceId, targetId) {
    const rel = document.getElementById(sourceId).value;
    const tgt = document.getElementById(targetId);
    if (tgt) tgt.innerHTML = getCommunityOptions(rel, 'Unknown');
};

// Global State
let voters = [];
let houses = [];
let chartInstance = null;
let currentRoute = 'dashboard';
let dashboardSearchCache = '';

// Active Modals Tracking
let currentEditingVoterSerial = null;
let currentEditingHouseId = null;

// House Creation State
let currentSquadForHouse = null;
let pendingHouseMembers = [];
let pendingSearchResult = null;

document.addEventListener('DOMContentLoaded', () => {
    // Navigation
    const navLinks = document.querySelectorAll('#nav-links li');
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            navLinks.forEach(l => l.classList.remove('active'));
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            link.classList.add('active');
            currentRoute = link.getAttribute('data-target');
            document.getElementById(currentRoute).classList.add('active');
            document.getElementById('sidebar').classList.remove('open');
            route(currentRoute);
        });
    });

    document.getElementById('mobile-nav-toggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.add('open');
    });
    document.getElementById('close-sidebar').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
    });

    // Settings
    document.getElementById('btn-import').addEventListener('click', handleImportCSV);
    document.getElementById('btn-clear-db').addEventListener('click', clearDatabase);

    // Modals
    document.querySelectorAll('.close-modal').forEach(el => el.addEventListener('click', closeModal));
    document.querySelector('.close-house-modal').addEventListener('click', closeHouseModal);
    document.querySelector('.close-house-edit-modal').addEventListener('click', closeHouseEditModal);

    document.getElementById('modal-save-btn').addEventListener('click', saveVoterDetails);

    document.getElementById('modal-save-house-edits-btn').addEventListener('click', async () => {
        if (currentEditingHouseId) {
            await saveHouseEdits(currentEditingHouseId);
            closeHouseEditModal();
        }
    });

    document.getElementById('modal-delete-house-btn').addEventListener('click', async () => {
        if (currentEditingHouseId && confirm("Are you sure you want to completely delete this house? Members will be unassigned.")) {
            // Unassign members
            const houseMembers = voters.filter(v => v.houseId === currentEditingHouseId);
            const updates = {};
            houseMembers.forEach(m => {
                updates[`voters/${m.serialNo}/houseId`] = null;
                updates[`voters/${m.serialNo}/squad`] = null;
            });
            updates[`houses/${currentEditingHouseId}`] = null;

            await rtdb.ref().update(updates);
            
            // Re-sequence remaining houses in this squad
            const squadNum = houses.find(h => h.id === currentEditingHouseId)?.squad;
            if (squadNum) {
                const remaining = houses.filter(h => h.squad === squadNum && h.id !== currentEditingHouseId).sort((a,b) => (a.order || 0) - (b.order || 0));
                const reseqUpdates = {};
                remaining.forEach((h, idx) => {
                    reseqUpdates[`houses/${h.id}/order`] = idx;
                });
                if (Object.keys(reseqUpdates).length > 0) await rtdb.ref().update(reseqUpdates);
            }
            
            closeHouseEditModal();
        }
    });

    // Live Sync
    rtdb.ref('houses').on('value', (snap) => {
        houses = Object.values(snap.val() || {});
        refreshCurrentRoute();
    });

    rtdb.ref('voters').on('value', (snap) => {
        voters = Object.values(snap.val() || {});
        refreshCurrentRoute();
    });
});

function refreshCurrentRoute() {
    if (currentEditingVoterSerial !== null) return;
    if (currentEditingHouseId !== null) return;
    route(currentRoute);
}

function route(target) {
    if (target === 'dashboard') renderDashboard();
    if (target === 'squads') renderSquads();
    if (target === 'politics') renderPolitics();
    if (target === 'polling') renderPolling();
    if (target === 'reports') renderReports();
}

// ---------------------------
// IMPORT & DB LOGIC
// ---------------------------
function clearDatabase() {
    if (confirm("Are you sure you want to delete ALL cloud records for EVERYONE?")) {
        rtdb.ref().update({ voters: null, houses: null });
        alert("Database cleared on cloud.");
    }
}

function handleImportCSV() {
    const fileInput = document.getElementById('csv-upload');
    const statusText = document.getElementById('import-status');
    if (fileInput.files.length === 0) {
        statusText.innerText = "Please select a file first.";
        return;
    }
    statusText.innerText = "Parsing and Uploading to Cloud...";

    Papa.parse(fileInput.files[0], {
        header: true,
        skipEmptyLines: true,
        complete: async function (results) {
            try {
                const updates = {};
                results.data.forEach(row => {
                    const serialNo = parseInt(row["ക്രമ നമ്പർ"]) || parseInt(row["Sl No"]) || 0;
                    if (serialNo !== 0) {
                        updates[`voters/${serialNo}`] = {
                            serialNo: serialNo,
                            name: row["പേര്"] || row["Name"] || "",
                            guardian: row["രക്ഷാകർത്താവിന്റെ പേര്"] || row["Guardian"] || "",
                            houseName: row["വീട്ടുപേര്"] || row["House Name"] || "",
                            age: parseInt(row["പ്രായം"]) || parseInt(row["Age"]) || 0,
                            gender: row["ലിംഗം"] || row["Gender"] || "",
                            voterId: row["വോട്ടർ ഐഡി നമ്പർ"] || row["ID Number"] || "",
                            houseId: null,
                            squad: null,
                            politics: 'Unknown',
                            location: 'Chittar',
                            remarks: '',
                            vehicleNeeded: false,
                            hasPolled: false,
                            religion: 'Unknown',
                            community: 'Unknown',
                            voteType: 'Normal',
                            willVote: (row["ലിംഗം"] || row["Gender"] || "") !== "" ? true : true // Default for all new imports for now, or refine logic
                        };
                        // Refine willVote based on location if present in CSV, but standard CSV doesn't have it yet.
                        // For this app, we assume everyone in Chittar will vote by default.
                        updates[`voters/${serialNo}/willVote`] = true; 
                    }
                });

                await rtdb.ref().update(updates);
                statusText.innerText = `Successfully synced ${Object.keys(updates).length} voters to Cloud!`;
            } catch (error) {
                console.error(error);
                statusText.innerText = "Error syncing data. Check console.";
            }
        }
    });
}

// ---------------------------
// DASHBOARD
// ---------------------------

// Dashboard UI Toggle
window.toggleSubcat = function (rel) {
    const el = document.getElementById(`subcat-summary-${rel}`);
    if (el) {
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
        const arrow = document.getElementById(`arrow-${rel}`);
        if (arrow) arrow.style.transform = el.style.display === 'none' ? 'rotate(0deg)' : 'rotate(180deg)';
    }
};

window.viewContactsByCaste = function (religion, community) {
    const navLinks = document.querySelectorAll('#nav-links li');
    navLinks.forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    
    const reportsLink = Array.from(navLinks).find(l => l.getAttribute('data-target') === 'reports');
    if (reportsLink) reportsLink.classList.add('active');
    document.getElementById('reports').classList.add('active');
    currentRoute = 'reports';

    // Set filters and generate
    setTimeout(() => {
        const relFilter = document.getElementById('report-filter-rel');
        if (relFilter) {
            relFilter.value = religion;
            updateReportCommunityConfig();
            document.getElementById('report-filter-comm').value = community || 'ALL';
            generateReport();
        }
    }, 100);
};

function renderDashboard() {
    const dashboard = document.getElementById('dashboard');
    if (voters.length === 0) {
        dashboard.innerHTML = `<h1>Dashboard</h1><div class="card"><p>No data. Go to Settings and import CSV.</p></div>`;
        return;
    }
    const males = voters.filter(v => v.gender === 'പുരുഷൻ' || v.gender.toLowerCase() === 'm').length;
    const females = voters.filter(v => v.gender === 'സ്ത്രീ' || v.gender.toLowerCase() === 'f').length;

    // Demographics
    const hindu = voters.filter(v => v.religion === 'Hindu');
    const christian = voters.filter(v => v.religion === 'Christian');
    const muslim = voters.filter(v => v.religion === 'Muslim');
    const unknown = voters.filter(v => !v.religion || v.religion === 'Unknown');

    const renderSubCats = (rel, arr, color) => {
        const cats = COMMUNITY_OPTS[rel].filter(c => c !== 'Unknown');
        const list = cats.map(c => {
            const count = arr.filter(v => v.community === c).length;
            return count > 0 ? `<li style="display:flex; justify-content:space-between; margin-bottom:3px;"><span>${c}</span> <strong>${count}</strong></li>` : '';
        }).join('');
        const unkCount = arr.filter(v => !v.community || v.community === 'Unknown').length;
        const unkStr = unkCount > 0 ? `<li style="display:flex; justify-content:space-between; margin-bottom:3px; color:var(--text-muted);"><span>Unknown Sub</span> <strong>${unkCount}</strong></li>` : '';

        return `<ul id="subcat-${rel}" style="display:none; list-style:none; padding:10px 0 0; margin-top:10px; border-top:1px solid var(--border); font-size:0.9em; text-align:left; color:${color};">${list}${unkStr}</ul>`;
    };

    dashboard.innerHTML = `
        <h1 style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 25px;">
            Dashboard Snapshot
            <span class="badge" style="background:var(--success)">🟢 Cloud Synced</span>
        </h1>
        <div class="grid-cols-3">
            <div class="card" style="text-align:center;">
                <h3 style="color:var(--text-muted)">Total Voters</h3>
                <h2 style="font-size: 2.5em; color: var(--primary)">${voters.length}</h2>
            </div>
            <div class="card" style="text-align:center;">
                <h3 style="color:var(--text-muted)">Male / Female</h3>
                <h2 style="font-size: 1.5em; margin-top:15px;">${males} / ${females}</h2>
            </div>
            <div class="card" style="text-align:center;">
                <h3 style="color:var(--text-muted)">Houses</h3>
                <h2 style="font-size: 2.5em; color: #f59e0b;">${houses.length}</h2>
            </div>
        </div>
        
        <div class="card">
            <h3>Global Search</h3>
            <input type="text" id="global-search" class="form-control" placeholder="Search by Serial No, Name, or House Name..." style="margin-top: 15px;">
            <div id="search-results" style="margin-top: 15px; max-height: 300px; overflow-y: auto;"></div>
        </div>

        <div id="summary-cards-container"></div>
    `;

    renderSummaryCards();

    // Rehydrate search cache
    const srchInput = document.getElementById('global-search');
    if (dashboardSearchCache) {
        srchInput.value = dashboardSearchCache;
        executeSearch(dashboardSearchCache);
    }

    srchInput.addEventListener('input', (e) => {
        dashboardSearchCache = e.target.value;
        executeSearch(dashboardSearchCache);
    });
}

function renderSummaryCards() {
    const container = document.getElementById('summary-cards-container');
    if (!container) return;

    // Helper for normalizing influential status (backward compatibility)
    const isInflu = (v) => v.isInfluential || (v.politics && v.politics.includes('Influ:'));

    // 1. Political Groups Detail
    const ldf = voters.filter(v => (v.politics || '').includes('LDF'));
    const udf = voters.filter(v => (v.politics || '').includes('UDF'));
    const nda = voters.filter(v => (v.politics || '').includes('NDA'));
    const neutral = voters.filter(v => (v.politics || '').includes('Neutral'));
    
    // Individual Influentials
    const ldfInflu = ldf.filter(isInflu).length;
    const udfInflu = udf.filter(isInflu).length;
    const ndaInflu = nda.filter(isInflu).length;
    const neutralInflu = neutral.filter(isInflu).length;

    // 2. Voting Stats
    const willVote = voters.filter(v => v.willVote !== false).length;
    const wontVote = voters.length - willVote;

    // 3. Location Breakdown
    const locStats = {
        'Out of Panchayath': voters.filter(v => v.location === 'Out of Panchayath').length,
        'Out of District': voters.filter(v => v.location === 'Out of District').length,
        'Out of Kerala': voters.filter(v => v.location === 'Out of Kerala').length,
        'Out of India': voters.filter(v => v.location === 'Out of India').length
    };

    // 4. Caste / Religion Summary
    const religionSummary = RELIGION_OPTS.map(rel => {
        const list = voters.filter(v => v.religion === rel);
        const subCats = COMMUNITY_OPTS[rel].map(comm => ({
            name: comm,
            count: list.filter(v => v.community === comm).length
        })).filter(c => c.count > 0);
        return { name: rel, count: list.length, subCats };
    });

    container.innerHTML = `
        <div class="grid-cols-2" style="margin-top: 20px;">
             <div class="card summary-card">
                <h3>Political Summary</h3>
                <table class="data-table" style="margin-top:10px; border:none;">
                    <tr>
                        <th style="background:none; border:none; padding:5px 0;">Party</th>
                        <th style="background:none; border:none; padding:5px 0; text-align:right;">Total</th>
                        <th style="background:none; border:none; padding:5px 0; text-align:right;">Influential</th>
                    </tr>
                    <tr>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0;">LDF</td>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0; text-align:right;"><strong>${ldf.length}</strong></td>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0; text-align:right; color:#ef4444;">${ldfInflu}</td>
                    </tr>
                    <tr>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0;">UDF</td>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0; text-align:right;"><strong>${udf.length}</strong></td>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0; text-align:right; color:#3b82f6;">${udfInflu}</td>
                    </tr>
                    <tr>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0;">NDA</td>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0; text-align:right;"><strong>${nda.length}</strong></td>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0; text-align:right; color:#f97316;">${ndaInflu}</td>
                    </tr>
                    <tr>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0;">Neutral</td>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0; text-align:right;"><strong>${neutral.length}</strong></td>
                        <td style="border:none; border-bottom:1px solid var(--border); padding:8px 0; text-align:right; color:#10b981;">${neutralInflu}</td>
                    </tr>
                </table>
            </div>

            <div class="card summary-card">
                <h3>Location Breakdown</h3>
                <div class="summary-item"><span>Out of Panchayath</span> <strong>${locStats['Out of Panchayath']}</strong></div>
                <div class="summary-item"><span>Out of District</span> <strong>${locStats['Out of District']}</strong></div>
                <div class="summary-item"><span>Out of Kerala</span> <strong>${locStats['Out of Kerala']}</strong></div>
                <div class="summary-item"><span>Out of India</span> <strong>${locStats['Out of India']}</strong></div>
            </div>
        </div>

        <div class="grid-cols-2" style="margin-top: 20px;">
            <div class="card summary-card" style="border-left: 4px solid var(--success);">
                <h3>Will Vote Stats</h3>
                <div style="text-align:center; margin-top:10px;">
                    <h2 style="font-size: 3em; color: var(--success);">${willVote}</h2>
                    <p style="color:var(--text-muted); font-weight:500;">Confirmed Will Vote</p>
                </div>
                <div class="summary-divider"></div>
                <div class="summary-item"><span>Not Sure / Won't</span> <strong>${wontVote}</strong></div>
                <div class="summary-item"><span>Total Booth Strength</span> <strong>${voters.length}</strong></div>
            </div>

            <div class="card summary-card">
                <h3>Caste Wise Summary</h3>
                <div style="max-height: 250px; overflow-y: auto;">
                    ${religionSummary.map(rel => `
                        <div class="caste-group">
                            <div class="caste-header" onclick="toggleSubcat('${rel.name}')">
                                <span>${rel.name}</span>
                                <div>
                                    <strong>${rel.count}</strong>
                                    <span id="arrow-${rel.name}" class="arrow">▼</span>
                                </div>
                            </div>
                            <div id="subcat-summary-${rel.name}" class="caste-subs" style="display:none;">
                                ${rel.subCats.map(s => `
                                    <div class="sub-item" onclick="viewContactsByCaste('${rel.name}', '${s.name}')" style="cursor:pointer;">
                                        <span>${s.name}</span>
                                        <strong>${s.count}</strong>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
}

function executeSearch(rawQuery) {
    const query = rawQuery.toLowerCase().trim();
    const resultsDiv = document.getElementById('search-results');
    if (!query) { resultsDiv.innerHTML = ''; return; }

    // Safely fallback undefined variables to empty strings to prevent exceptions
    const results = voters.filter(v =>
        (v.serialNo && v.serialNo.toString().includes(query)) ||
        (v.name || '').toLowerCase().includes(query) ||
        (v.houseName || '').toLowerCase().includes(query)
    ).slice(0, 10);

    if (results.length === 0) {
        resultsDiv.innerHTML = '<p class="text-muted">No results found.</p>';
    } else {
        resultsDiv.innerHTML = results.map(v => `
            <div style="padding: 10px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="openVoterModal(${v.serialNo})">
                <div>
                    <strong>#${v.serialNo} ${v.name || 'Unknown'}</strong> 
                    ${v.hasPolled ? '<span class="badge polled">Polled</span>' : ''}
                    <br>
                    <small style="color:var(--text-muted)">${v.houseName || 'No House'} (${v.age} / ${v.gender})</small>
                </div>
            </div>
        `).join('');
    }
}

function renderChart() {
    // Pie chart removed as per request
}

// ---------------------------
// SQUADS & HOUSES
// ---------------------------
function renderSquads() {
    const squadsDiv = document.getElementById('squads');
    squadsDiv.innerHTML = `
        <h1>Squad & House Manager</h1>
        <div class="squad-tabs-row" id="squad-tabs">
            ${SQUADS.map(num => `
                <div class="card" style="text-align:center; cursor:pointer;" onclick="renderSquadDetails(${num})">
                    <h2>Squad ${num}</h2>
                    <p>${houses.filter(h => h.squad === num).length} Houses</p>
                </div>
            `).join('')}
        </div>
        <div id="squad-details" style="display:none; margin-top:20px;"></div>
    `;
}

window.renderSquadDetails = renderSquadDetails;
function renderSquadDetails(squadNum) {
    currentSquadForHouse = squadNum;
    const details = document.getElementById('squad-details');
    details.style.display = 'block';
    const squadHouses = houses.filter(h => h.squad === squadNum).sort((a,b) => (a.order || 0) - (b.order || 0));

    details.innerHTML = `
        <h2 style="margin-bottom:15px;">Squad ${squadNum} Details</h2>
        <button class="btn btn-success" onclick="openHouseModal(${squadNum})" style="margin-bottom:20px;">+ Create New House</button>
        <div class="grid-cols-3">
            ${squadHouses.map((h, idx) => {
        const members = voters.filter(v => v.houseId === h.id);
        return `
                <div class="card" style="transition: transform 0.2s; position:relative;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='translateY(0)'">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <h4 style="cursor:pointer;" onclick="openHouseManage('${h.id}')">${idx + 1}. ${h.name} <small class="text-muted">(${members.length})</small></h4>
                        <div style="display:flex; gap:2px; align-items:center;">
                            <button class="btn btn-outline" style="padding:2px 5px; font-size:0.75em;" title="Move Up" onclick="moveHouse('${h.id}', -1)">↑</button>
                            <input type="number" value="${idx + 1}" style="width:40px; text-align:center; font-size:0.8em; border:1px solid var(--border); border-radius:4px;" onchange="moveHouse('${h.id}', this.value - ${idx + 1})" onclick="event.stopPropagation()">
                            <button class="btn btn-outline" style="padding:2px 5px; font-size:0.75em;" title="Move Down" onclick="moveHouse('${h.id}', 1)">↓</button>
                        </div>
                    </div>
                    <p class="text-muted" style="font-size:0.8em; margin-top:8px; cursor:pointer;" onclick="openHouseManage('${h.id}')">Click to manage members</p>
                </div>
                `;
    }).join('')}
        </div>
        ${squadHouses.length === 0 ? '<p class="text-muted">No houses assigned to this squad yet.</p>' : ''}
    `;
}

// ---------------------------
// HOUSE DETAILS QUICK-EDIT
// ---------------------------
window.openHouseManage = function (houseId) {
    currentEditingHouseId = houseId;
    const house = houses.find(h => h.id === houseId);
    if (!house) return;
    const members = voters.filter(v => v.houseId === houseId);

    document.getElementById('house-edit-title').innerText = `Manage House: ${house.name}`;
    
    // Set common Religion & Community based on first member or house data
    const firstMember = members[0] || {};
    const commonRel = firstMember.religion || 'Unknown';
    const commonComm = firstMember.community || 'Unknown';
    document.getElementById('common-house-rel').value = commonRel;
    document.getElementById('common-house-comm').innerHTML = getCommunityOptions(commonRel, commonComm);
    const body = document.getElementById('house-edit-body');
    body.innerHTML = `
        <table class="data-table">
            <tr>
                <th style="min-width: 150px;">Member Name</th>
                <th>Politics</th>
                <th>Location</th>
                <th>Vote Type</th>
                <th style="text-align:center;">Will Vote</th>
                <th style="min-width: 80px;">Remarks</th>
                <th style="text-align:center;">Vehicle</th>
                <th style="text-align:center;">Influ</th>
                <th style="text-align:center;">Action</th>
            </tr>
            ${members.map(m => `
            <tr>
                <td>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span><strong>#${m.serialNo}</strong> ${m.name}</span>
                        <button class="btn btn-outline" style="padding:2px 6px; font-size:0.75em;" onclick="openVoterModal(${m.serialNo})">✏️</button>
                    </div>
                </td>
                <td>
                    <select id="qh-pol-${m.serialNo}" class="form-control">
                        ${POLITICS_OPTIONS.map(opt => `<option value="${opt}" ${(m.politics || 'Unknown') === opt ? 'selected' : ''}>${opt}</option>`).join('')}
                    </select>
                </td>
                <td>
                    <select id="qh-loc-${m.serialNo}" class="form-control" onchange="handleLocationChange(${m.serialNo})">
                        ${LOCATION_OPTIONS.map(opt => `<option value="${opt}" ${(m.location || 'Chittar') === opt ? 'selected' : ''}>${opt}</option>`).join('')}
                    </select>
                </td>
                <td>
                    <select id="qh-vtype-${m.serialNo}" class="form-control">
                        ${VOTE_TYPE_OPTIONS.map(opt => `<option value="${opt}" ${(m.voteType || 'Normal') === opt ? 'selected' : ''}>${opt}</option>`).join('')}
                    </select>
                </td>
                <td style="text-align:center;">
                    <input type="checkbox" id="qh-will-${m.serialNo}" ${m.willVote !== false ? 'checked' : ''} style="width:18px; height:18px;">
                </td>
                <td>
                    <input type="text" id="qh-rem-${m.serialNo}" class="form-control" value="${m.remarks || ''}" placeholder="Remarks...">
                </td>
                <td style="text-align:center;">
                    <input type="checkbox" id="qh-veh-${m.serialNo}" ${m.vehicleNeeded ? 'checked' : ''} style="width:18px; height:18px;">
                </td>
                <td style="text-align:center;">
                    <input type="checkbox" id="qh-inf-${m.serialNo}" ${m.isInfluential || (m.politics && m.politics.includes('Influ:')) ? 'checked' : ''} style="width:18px; height:18px;">
                </td>
                <td style="text-align:center;">
                    <button class="badge" style="background:#ef4444; border:none; cursor:pointer;" onclick="removeVoterFromHouse(${m.serialNo}, '${houseId}')">Delete</button>
                </td>
            </tr>
            `).join('')}
        </table>
        ${members.length === 0 ? '<p class="text-muted" style="margin-top:10px;">Warning: This house is empty.</p>' : ''}
    `;
    document.getElementById('house-edit-modal').classList.add('flex');
}

function closeHouseEditModal() {
    document.getElementById('house-edit-modal').classList.remove('flex');
    currentEditingHouseId = null;
    route(currentRoute);
}

window.saveHouseEdits = async function (houseId) {
    const members = voters.filter(v => v.houseId === houseId);
    const updates = {};
    const commonRel = document.getElementById('common-house-rel').value;
    const commonComm = document.getElementById('common-house-comm').value;

    for (let m of members) {
        updates[`voters/${m.serialNo}/politics`] = document.getElementById(`qh-pol-${m.serialNo}`).value;
        updates[`voters/${m.serialNo}/location`] = document.getElementById(`qh-loc-${m.serialNo}`).value;
        updates[`voters/${m.serialNo}/remarks`] = document.getElementById(`qh-rem-${m.serialNo}`).value;
        updates[`voters/${m.serialNo}/vehicleNeeded`] = document.getElementById(`qh-veh-${m.serialNo}`).checked;
        updates[`voters/${m.serialNo}/isInfluential`] = document.getElementById(`qh-inf-${m.serialNo}`).checked;
        updates[`voters/${m.serialNo}/willVote`] = document.getElementById(`qh-will-${m.serialNo}`).checked;
        updates[`voters/${m.serialNo}/voteType`] = document.getElementById(`qh-vtype-${m.serialNo}`).value;
        updates[`voters/${m.serialNo}/religion`] = commonRel;
        updates[`voters/${m.serialNo}/community`] = commonComm;
    }
    await rtdb.ref().update(updates);
}

window.removeVoterFromHouse = async function (sno, houseId) {
    if (!confirm(`Remove voter #${sno}?`)) return;
    const voter = voters.find(v => v.serialNo === sno);
    if (voter) {
        const updates = {};
        updates[`voters/${sno}/houseId`] = null;
        updates[`voters/${sno}/squad`] = null;
        await rtdb.ref().update(updates);

        voter.houseId = null;
        const remaining = voters.filter(v => v.houseId === houseId);
        if (remaining.length === 0) {
            await rtdb.ref(`houses/${houseId}`).remove();
            closeHouseEditModal();
        } else {
            openHouseManage(houseId);
        }
    }
}

// ---------------------------
// HOUSE CREATION MODAL LOGIC
// ---------------------------
window.openHouseModal = function (squadNum) {
    currentSquadForHouse = squadNum;
    pendingHouseMembers = [];
    document.getElementById('house-search-serial').value = '';
    document.getElementById('house-search-result').innerHTML = '';
    document.getElementById('house-final-name').value = '';
    renderPendingHouseMembers();
    document.getElementById('house-modal').classList.add('flex');
}

function closeHouseModal() {
    document.getElementById('house-modal').classList.remove('flex');
}

window.searchHouseVoter = function () {
    const inputStr = document.getElementById('house-search-serial').value.trim();
    const resDiv = document.getElementById('house-search-result');
    if (!inputStr) {
        resDiv.innerHTML = '';
        pendingSearchResult = null;
        return;
    }
    const sno = parseInt(inputStr);
    const voter = voters.find(v => v.serialNo === sno);

    if (!voter) {
        resDiv.innerHTML = '<span style="color:#ef4444">Voter not found.</span>';
        pendingSearchResult = null;
        return;
    }

    // Safety check - Firebase deletes null properties entirely. Checking truthiness instead of strictly not null.
    if (voter.houseId) {
        resDiv.innerHTML = '<span style="color:#ef4444">Already attached to a house!</span>';
        pendingSearchResult = null;
        return;
    }

    if (pendingHouseMembers.some(m => m.serialNo === voter.serialNo)) {
        resDiv.innerHTML = '<span style="color:#f59e0b">Already added to list.</span>';
        pendingSearchResult = null;
        return;
    }

    pendingSearchResult = voter;
    resDiv.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#e0f2fe; padding:10px; border-radius:6px; color:#0369a1;">
            <div>
                <strong>#${voter.serialNo} - ${voter.name || 'Unknown'}</strong><br>
                <small>${voter.houseName || 'No original house record'}</small>
            </div>
            <div style="display:flex; flex-direction:column; gap:5px;">
                <button class="btn btn-outline" style="padding:4px 8px; font-size:0.85em; background:white;" onclick="document.getElementById('voter-modal').style.zIndex=9999; openVoterModal(${voter.serialNo})">✏️ Edit</button>
                <button class="btn btn-success" style="padding:4px 8px; font-size:0.85em;" onclick="addPendingVoter()">Add to List</button>
            </div>
        </div>
    `;
}

window.addPendingVoter = function () {
    if (!pendingSearchResult) return;
    pendingHouseMembers.push(pendingSearchResult);

    const counts = {};
    pendingHouseMembers.forEach(m => counts[m.houseName] = (counts[m.houseName] || 0) + 1);
    const bestName = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b, "");
    document.getElementById('house-final-name').value = bestName;

    document.getElementById('house-search-serial').value = '';
    document.getElementById('house-search-result').innerHTML = '';
    pendingSearchResult = null;
    document.getElementById('house-search-serial').focus();
    renderPendingHouseMembers();
}

window.removePendingVoter = function (sno) {
    pendingHouseMembers = pendingHouseMembers.filter(m => m.serialNo !== sno);
    renderPendingHouseMembers();
}

function renderPendingHouseMembers() {
    const container = document.getElementById('house-selected-members');
    if (pendingHouseMembers.length === 0) {
        container.innerHTML = '<span class="text-muted">No members selected yet.</span>';
        return;
    }
    container.innerHTML = pendingHouseMembers.map(m => `
        <div style="display:inline-block; background:var(--bg-color); border:1px solid var(--border); padding:5px 10px; border-radius:20px; margin:5px; font-size:0.9em;">
            #${m.serialNo} ${m.name || 'Unknown'} 
            <span style="cursor:pointer; margin-left:5px; box-shadow:0 0 2px #ccc; padding:2px; border-radius:4px;" onclick="document.getElementById('voter-modal').style.zIndex=9999; openVoterModal(${m.serialNo})">✏️</span>
            <span style="color:#ef4444; cursor:pointer; margin-left:5px; font-weight:bold;" onclick="removePendingVoter(${m.serialNo})">✕</span>
        </div>
    `).join('');
}

document.getElementById('modal-create-house-btn').addEventListener('click', async () => {
    if (pendingHouseMembers.length === 0) { alert('Add at least one member!'); return; }
    const finalName = document.getElementById('house-final-name').value.trim();
    if (!finalName) { alert('Provide a house name!'); return; }

    const squadHouses = houses.filter(h => h.squad === currentSquadForHouse);
    const newOrder = squadHouses.length;

    const newId = rtdb.ref('houses').push().key;
    const newHouse = { id: newId, name: finalName, squad: currentSquadForHouse, order: newOrder };

    const updates = {};
    updates[`houses/${newId}`] = newHouse;
    pendingHouseMembers.forEach(v => {
        updates[`voters/${v.serialNo}/houseId`] = newId;
        updates[`voters/${v.serialNo}/squad`] = currentSquadForHouse;
    });

    await rtdb.ref().update(updates);
    closeHouseModal();
    renderSquadDetails(currentSquadForHouse);
});

// ---------------------------
// POLITICS PAGE
// ---------------------------
function renderPolitics() {
    const politicsDiv = document.getElementById('politics');

    const LDF = voters.filter(v => v.politics && v.politics.includes('LDF'));
    const UDF = voters.filter(v => v.politics && v.politics.includes('UDF'));
    const NDA = voters.filter(v => v.politics && v.politics.includes('NDA'));

    politicsDiv.innerHTML = `
        <h1>Political View</h1>
        <div class="grid-cols-4">
            <button class="btn" style="background:#ef4444" onclick="showPoliticsList('LDF')">LDF Array (${LDF.length})</button>
            <button class="btn" style="background:#3b82f6" onclick="showPoliticsList('UDF')">UDF Array (${UDF.length})</button>
            <button class="btn" style="background:#f97316" onclick="showPoliticsList('NDA')">NDA Array (${NDA.length})</button>
            <button class="btn" style="background:#64748b" onclick="showPoliticsList('Neutral')">Neutral/Others</button>
        </div>
        <div id="politics-list" class="card" style="margin-top:20px; display:none; max-height:60vh; overflow-y:auto;"></div>
    `;
}

window.showPoliticsList = showPoliticsList;
function showPoliticsList(party) {
    const listDiv = document.getElementById('politics-list');
    listDiv.style.display = 'block';

    let filtered;
    if (party === 'Neutral') {
        filtered = voters.filter(v => !v.politics || v.politics === 'Unknown' || v.politics.includes('Neutral'));
    } else {
        filtered = voters.filter(v => v.politics && v.politics.includes(party));
    }

    listDiv.innerHTML = `
        <h3>${party} Linked Voters</h3>
        <table class="data-table">
            <tr style="border-bottom:2px solid var(--border);">
                <th>Sl.No</th>
                <th>Name</th>
                <th>Location</th>
                <th>Vehicle</th>
                <th>Status</th>
            </tr>
            ${filtered.map(v => `
            <tr style="cursor:pointer;" onclick="openVoterModal(${v.serialNo})">
                <td style="padding:10px;">#${v.serialNo}</td>
                <td>${v.name}</td>
                <td><small>${v.location}</small></td>
                <td>${v.vehicleNeeded ? '🚗 Yes' : 'No'}</td>
                <td>${v.hasPolled ? '<span class="badge polled">Polled</span>' : '<span class="badge" style="background:#ef4444">Not Polled</span>'}</td>
            </tr>
            `).join('')}
        </table>
    `;
}

// ---------------------------
// REPORT PAGE
// ---------------------------
window.updateReportCommunityConfig = function () {
    const rel = document.getElementById('report-filter-rel').value;
    const commWrap = document.getElementById('report-filter-comm');
    if (rel === 'ALL') {
        commWrap.innerHTML = '<option value="ALL">All</option>';
    } else {
        commWrap.innerHTML = '<option value="ALL">All</option>' + (COMMUNITY_OPTS[rel] || []).map(o => `<option value="${o}">${o}</option>`).join('');
    }
}

function renderReports() {
    const reportsDiv = document.getElementById('reports');
    reportsDiv.innerHTML = `
        <h1>Custom Data Reports</h1>
        <div class="card" style="display:flex; gap:15px; flex-wrap:wrap; align-items:flex-end; background:var(--sidebar-bg); color:white;">
            <div class="form-group" style="margin-bottom:0; flex:1; min-width:120px;">
                <label>Politics</label>
                <select id="report-filter-pol" class="form-control" style="color:black; padding:5px;">
                    <option value="ALL">All</option>
                    ${POLITICS_OPTIONS.map(o => `<option value="${o}">${o}</option>`).join('')}
                </select>
            </div>
            <div class="form-group" style="margin-bottom:0; flex:1; min-width:120px;">
                <label>Religion</label>
                <select id="report-filter-rel" class="form-control" onchange="updateReportCommunityConfig()" style="color:black; padding:5px;">
                    <option value="ALL">All</option>
                    ${RELIGION_OPTS.map(o => `<option value="${o}">${o}</option>`).join('')}
                </select>
            </div>
            <div class="form-group" style="margin-bottom:0; flex:1; min-width:120px;">
                <label>Community</label>
                <select id="report-filter-comm" class="form-control" style="color:black; padding:5px;">
                    <option value="ALL">All</option>
                </select>
            </div>
            <div class="form-group" style="margin-bottom:0; flex:1; min-width:120px;">
                <label>Location</label>
                <select id="report-filter-loc" class="form-control" style="color:black; padding:5px;">
                    <option value="ALL">All</option>
                    ${LOCATION_OPTIONS.map(o => `<option value="${o}">${o}</option>`).join('')}
                </select>
            </div>
            <div class="form-group" style="margin-bottom:0; flex:1; min-width:120px;">
                <label>Vehicle</label>
                <select id="report-filter-veh" class="form-control" style="color:black; padding:5px;">
                    <option value="ALL">All</option>
                    <option value="YES">Needed</option>
                    <option value="NO">Not Needed</option>
                </select>
            </div>
            <div class="form-group" style="margin-bottom:0; flex:1; min-width:120px;">
                <label>Polled</label>
                <select id="report-filter-poll" class="form-control" style="color:black; padding:5px;">
                    <option value="ALL">All</option>
                    <option value="YES">Polled</option>
                    <option value="NO">Not Polled</option>
                </select>
            </div>
            <div class="form-group" style="margin-bottom:0; flex:1; min-width:120px;">
                <label>Vote Type</label>
                <select id="report-filter-voteType" class="form-control" style="color:black; padding:5px;">
                    <option value="ALL">All</option>
                    ${VOTE_TYPE_OPTIONS.map(o => `<option value="${o}">${o}</option>`).join('')}
                </select>
            </div>
            <div class="form-group" style="margin-bottom:0; flex:1; min-width:120px;">
                <label>Will Vote</label>
                <select id="report-filter-will" class="form-control" style="color:black; padding:5px;">
                    <option value="ALL">All</option>
                    <option value="YES">Will Vote</option>
                    <option value="NO">Not Sure/Won't</option>
                </select>
            </div>
            <div class="form-group" style="margin-bottom:0; flex:1; min-width:120px;">
                <label>Influence</label>
                <select id="report-filter-inf" class="form-control" style="color:black; padding:5px;">
                    <option value="ALL">All Voters</option>
                    <option value="INF">Influential Only</option>
                    <option value="NON">Non-Influential Only</option>
                </select>
            </div>
            <button class="btn btn-success" onclick="generateReport()" style="padding:10px 20px;">Load</button>
        </div>
        
        <div class="card" style="display:flex; justify-content:space-between; align-items:center;">
             <h3 style="margin:0;">Results: <span id="report-count" style="color:var(--primary);">0</span> voters</h3>
             <button class="btn btn-outline" onclick="window.print()">Print Report</button>
        </div>
        
        <div id="report-results" style="overflow-x:auto;"></div>
    `;
    generateReport();
}

window.generateReport = function () {
    const fPol = document.getElementById('report-filter-pol').value;
    const fLoc = document.getElementById('report-filter-loc').value;
    const fVeh = document.getElementById('report-filter-veh').value;
    const fPoll = document.getElementById('report-filter-poll').value;
    const fRel = document.getElementById('report-filter-rel').value;
    const fComm = document.getElementById('report-filter-comm').value;
    const fWill = document.getElementById('report-filter-will').value;
    const fInf = document.getElementById('report-filter-inf').value;
    const fVoteType = document.getElementById('report-filter-voteType').value;

    let filtered = voters.filter(v => {
        if (fPol !== 'ALL' && v.politics !== fPol) return false;
        if (fLoc !== 'ALL' && v.location !== fLoc) return false;
        if (fVoteType !== 'ALL' && (v.voteType || 'Normal') !== fVoteType) return false;
        if (fVeh === 'YES' && !v.vehicleNeeded) return false;
        if (fVeh === 'NO' && v.vehicleNeeded) return false;
        if (fPoll === 'YES' && !v.hasPolled) return false;
        if (fPoll === 'NO' && v.hasPolled) return false;
        if (fRel !== 'ALL' && v.religion !== fRel) return false;
        if (fComm !== 'ALL' && v.community !== fComm) return false;
        if (fWill === 'YES' && v.willVote === false) return false;
        if (fWill === 'NO' && v.willVote !== false) return false;

        // Influence Filter
        const isInflu = v.isInfluential || (v.politics && v.politics.includes('Influ:'));
        if (fInf === 'INF' && !isInflu) return false;
        if (fInf === 'NON' && isInflu) return false;

        return true;
    });

    document.getElementById('report-count').innerText = filtered.length;

    const res = document.getElementById('report-results');
    if (filtered.length === 0) {
        res.innerHTML = '<p class="text-muted">No voters match your filters.</p>';
        return;
    }
    res.innerHTML = `
        <table class="data-table">
            <tr>
                <th style="padding:10px;">Sl No</th>
                <th>Name</th>
                <th>Age/Sex</th>
                <th>Religion/Comm</th>
                <th>Politics</th>
                <th>Location</th>
                <th>Vote Type</th>
                <th>Will Vote</th>
                <th>Polled</th>
            </tr>
            ${filtered.sort((a, b) => a.serialNo - b.serialNo).map(v => `
            <tr>
                <td><strong>#${v.serialNo}</strong></td>
                <td>${v.name || 'Unknown'}<br><small class="text-muted">${v.houseName || ''}</small></td>
                <td>${v.age} / ${v.gender}</td>
                <td>${v.religion !== 'Unknown' ? v.religion : '-'} <br> <small>${v.community === 'Unknown' ? '' : v.community}</small></td>
                <td><span class="badge ${v.politics.toLowerCase().replace(':', '')}">${v.politics}</span></td>
                <td>${v.location} ${v.vehicleNeeded ? '<br>🚗 Yes' : ''}</td>
                <td>${v.voteType || 'Normal'}</td>
                <td style="text-align:center;">${v.willVote !== false ? '✅' : '❌'}</td>
                <td>${v.hasPolled ? '✅ Yes' : '❌ No'}</td>
            </tr>
            `).join('')}
        </table>
    `;
}

// ---------------------------
// POLLING DAY
// ---------------------------

window.toggleMissingList = function (party, btn) {
    const grid = document.getElementById('unpolled-grid');
    const container = document.getElementById('missing-list-container');
    const listBody = document.getElementById('missing-list-body');
    const recent = document.getElementById('recent-polled-container');
    const title = document.getElementById('missing-list-title');

    if (container.style.display === 'none' || container.getAttribute('data-current-party') !== party) {
        // Show List
        grid.style.display = 'none';
        container.style.display = 'block';
        container.setAttribute('data-current-party', party);
        if (recent) recent.style.display = 'none';
        
        title.innerText = `Missing ${party} Voters`;
        
        let filtered;
        if (party === 'Neutral') {
            filtered = voters.filter(v => !v.hasPolled && (!v.politics || v.politics === 'Unknown' || v.politics.includes('Neutral')));
        } else {
            filtered = voters.filter(v => !v.hasPolled && v.politics && v.politics.includes(party));
        }

        listBody.innerHTML = filtered.length === 0 
            ? `<tr><td colspan="5" style="text-align:center; padding:20px;">All ${party} Voters have polled! 🎉</td></tr>`
            : filtered.map(v => `
                <tr>
                    <td><strong>#${v.serialNo}</strong></td>
                    <td>${v.name || 'Unknown'}</td>
                    <td><small class="text-muted">${v.houseName || '-'}</small></td>
                    <td>${v.location} ${v.vehicleNeeded ? '🚗' : ''}</td>
                    <td><button class="btn btn-success" style="padding:4px 10px; font-size:0.85em;" onclick="directPollVoter(${v.serialNo})">Cast Vote</button></td>
                </tr>
            `).join('');
        
        // Update all missing buttons to "Back" if they are the one clicked
        document.querySelectorAll('.missing-btn').forEach(b => b.innerHTML = b.getAttribute('data-original'));
        btn.innerHTML = '← Back to All';
    } else {
        // Hide List
        grid.style.display = 'grid';
        container.style.display = 'none';
        container.setAttribute('data-current-party', '');
        if (recent) recent.style.display = 'block';
        btn.innerHTML = btn.getAttribute('data-original');
    }
}

function renderPolling() {
    const pollingDiv = document.getElementById('polling');
    const total = voters.length;
    if (total === 0) { pollingDiv.innerHTML = "No sync data yet."; return; }

    const polled = voters.filter(v => v.hasPolled).length;

    const ldfPolled = voters.filter(v => v.hasPolled && v.politics && v.politics.includes('LDF')).length;
    const udfPolled = voters.filter(v => v.hasPolled && v.politics && v.politics.includes('UDF')).length;
    const ndaPolled = voters.filter(v => v.hasPolled && v.politics && v.politics.includes('NDA')).length;
    const neutralPolled = voters.filter(v => v.hasPolled && (!v.politics || v.politics === 'Unknown' || v.politics.includes('Neutral'))).length;

    const unpolledVoters = voters.filter(v => !v.hasPolled).sort((a, b) => a.serialNo - b.serialNo);
    const missingLDF = unpolledVoters.filter(v => v.politics && v.politics.includes('LDF')).length;
    const missingUDF = unpolledVoters.filter(v => v.politics && v.politics.includes('UDF')).length;
    const missingNDA = unpolledVoters.filter(v => v.politics && v.politics.includes('NDA')).length;
    const missingNeutral = unpolledVoters.filter(v => !v.politics || v.politics === 'Unknown' || v.politics.includes('Neutral')).length;

    pollingDiv.innerHTML = `
        <h1>Polling Day Live</h1>
        
        <div class="card" style="text-align:center;">
            <h3 style="color:var(--text-muted)">Total Polled</h3>
            <h1 style="font-size:3em; color:var(--success); margin-top:10px;">${polled} / ${total}</h1>
        </div>
        
        <div class="grid-cols-4">
            <div class="card" style="border-left: 4px solid #ef4444; text-align:center;">
                <h3 style="color:#ef4444;">LDF</h3>
                <h2 style="font-size:2em;">${ldfPolled}</h2>
            </div>
            <div class="card" style="border-left: 4px solid #3b82f6; text-align:center;">
                <h3 style="color:#3b82f6;">UDF</h3>
                <h2 style="font-size:2em;">${udfPolled}</h2>
            </div>
            <div class="card" style="border-left: 4px solid #f97316; text-align:center;">
                <h3 style="color:#f97316;">NDA</h3>
                <h2 style="font-size:2em;">${ndaPolled}</h2>
            </div>
            <div class="card" style="border-left: 4px solid #64748b; text-align:center;">
                <h3 style="color:#64748b;">Neutral Polled</h3>
                <h2 style="font-size:2em;">${neutralPolled}</h2>
            </div>
        </div>
        
        <div style="display:flex; gap:20px; flex-wrap:wrap;">
            <div class="card" id="unpolled-container" style="flex:2; min-width:300px;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                    <h3>Unpolled Voters <small class="text-muted">(${unpolledVoters.length})</small></h3>
                    <div style="display:flex; gap:5px; flex-wrap:wrap;">
                        <button class="btn missing-btn" style="background:#ef4444; font-size: 0.8em; padding: 5px 10px;" data-original="LDF (${missingLDF})" onclick="toggleMissingList('LDF', this)">LDF (${missingLDF})</button>
                        <button class="btn missing-btn" style="background:#3b82f6; font-size: 0.8em; padding: 5px 10px;" data-original="UDF (${missingUDF})" onclick="toggleMissingList('UDF', this)">UDF (${missingUDF})</button>
                        <button class="btn missing-btn" style="background:#f97316; font-size: 0.8em; padding: 5px 10px;" data-original="NDA (${missingNDA})" onclick="toggleMissingList('NDA', this)">NDA (${missingNDA})</button>
                        <button class="btn missing-btn" style="background:#64748b; font-size: 0.8em; padding: 5px 10px;" data-original="Neutral (${missingNeutral})" onclick="toggleMissingList('Neutral', this)">Neutral (${missingNeutral})</button>
                    </div>
                </div>
                
                <div class="serial-grid" id="unpolled-grid" style="margin-top:15px;">
                    ${unpolledVoters.map(v => `<div class="serial-btn" id="sbtn-${v.serialNo}" onclick="directPollVoter(${v.serialNo})">${v.serialNo}</div>`).join('')}
                </div>
                
                <div id="missing-list-container" style="display:none; margin-top:15px; max-height:400px; overflow-y:auto; overflow-x:auto;">
                    <h4 id="missing-list-title" style="margin-bottom:10px; color:var(--primary);"></h4>
                    <table class="data-table" style="font-size:0.9em;">
                        <thead>
                            <tr><th style="padding:10px;">Sl No</th><th>Name</th><th>House</th><th>Location</th><th>Action</th></tr>
                        </thead>
                        <tbody id="missing-list-body"></tbody>
                    </table>
                </div>
            </div>
            
            <div class="card" id="recent-polled-container" style="flex:1; min-width:300px;">
                <h3>Recent Polled</h3>
                <div id="polled-history" style="max-height: 500px; overflow-y:auto; margin-top:10px;">
                    ${voters.filter(v => v.hasPolled).slice(-15).reverse().map(v =>
        `<div style="padding:10px 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
                            <span>✅ #${v.serialNo} - ${v.name || 'Unknown'}</span>
                            <button class="badge" style="background:#ef4444; border:none; cursor:pointer;" onclick="undoPollVoter(${v.serialNo})">Undo</button>
                        </div>`
    ).join('')}
                </div>
            </div>
        </div>
    `;
}

window.directPollVoter = async function (sno) {
    const voter = voters.find(v => v.serialNo === sno);
    if (!voter) return;
    voter.hasPolled = true;
    const btn = document.getElementById(`sbtn-${sno}`);
    if (btn) btn.remove();
    await rtdb.ref(`voters/${sno}/hasPolled`).set(true);
}

window.undoPollVoter = async function (sno) {
    const voter = voters.find(v => v.serialNo === sno);
    if (!voter) return;
    voter.hasPolled = false;
    await rtdb.ref(`voters/${sno}/hasPolled`).set(false);
}

// ---------------------------
// VOTER MODAL (Global)
// ---------------------------
function openVoterModal(serialNo) {
    const voter = voters.find(v => v.serialNo === serialNo);
    if (!voter) return;

    currentEditingVoterSerial = serialNo;
    document.getElementById('modal-voter-name').innerText = `#${voter.serialNo} - ${voter.name || 'Unknown'}`;

    const body = document.getElementById('modal-voter-body');
    body.innerHTML = `
        <div style="margin-bottom:10px; font-size:0.9em; color:var(--text-muted);">
            <strong>ID:</strong> ${voter.voterId}
        </div>
        <div class="form-group grid-cols-2" style="margin-bottom:10px;">
            <div><label>Name</label><input type="text" id="modal-name" class="form-control" value="${voter.name || ''}"></div>
            <div>
                 <label>Age & Gender</label>
                 <div style="display:flex; gap:5px;">
                      <input type="number" id="modal-age" class="form-control" value="${voter.age || ''}" style="width:70px;">
                      <input type="text" id="modal-gender" class="form-control" value="${voter.gender || ''}">
                 </div>
            </div>
        </div>
        <div class="form-group grid-cols-2" style="margin-bottom:15px;">
            <div><label>Guardian</label><input type="text" id="modal-guardian" class="form-control" value="${voter.guardian || ''}"></div>
            <div><label>Original House Name</label><input type="text" id="modal-houseName" class="form-control" value="${voter.houseName || ''}"></div>
        </div>
        <hr style="border:0; border-top:1px solid var(--border); margin:15px 0;">
        
        <div class="form-group grid-cols-2">
            <div>
                <label>Religion</label>
                <select id="modal-religion" class="form-control" onchange="handleReligionChange('modal-religion', 'modal-community')">
                    ${RELIGION_OPTS.map(opt => `<option value="${opt}" ${(voter.religion || 'Unknown') === opt ? 'selected' : ''}>${opt}</option>`).join('')}
                </select>
            </div>
            <div>
                <label>Community</label>
                <select id="modal-community" class="form-control">
                    ${getCommunityOptions((voter.religion || 'Unknown'), (voter.community || 'Unknown'))}
                </select>
            </div>
        </div>

        <div class="form-group">
            <label>Politics</label>
            <select id="modal-politics" class="form-control">
                ${POLITICS_OPTIONS.map(opt => `<option value="${opt}" ${(voter.politics || 'Unknown') === opt ? 'selected' : ''}>${opt}</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>Current Location</label>
            <select id="modal-location" class="form-control">
                ${LOCATION_OPTIONS.map(opt => `<option value="${opt}" ${(voter.location || 'Chittar') === opt ? 'selected' : ''}>${opt}</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>Remarks / Influence Details</label>
            <input type="text" id="modal-remarks" class="form-control" value="${voter.remarks || ''}" placeholder="Any specific remarks...">
        </div>
        <div class="form-group">
            <label>Type of Vote</label>
            <select id="modal-voteType" class="form-control">
                ${VOTE_TYPE_OPTIONS.map(opt => `<option value="${opt}" ${(voter.voteType || 'Normal') === opt ? 'selected' : ''}>${opt}</option>`).join('')}
            </select>
        </div>
        <div class="form-group" style="display:flex; align-items:center; gap:20px;">
            <div style="display:flex; align-items:center; gap:10px;">
                <input type="checkbox" id="modal-vehicle" ${voter.vehicleNeeded ? 'checked' : ''} style="width:20px; height:20px;">
                <label style="margin:0; cursor:pointer;" for="modal-vehicle">Needs Vehicle</label>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
                <input type="checkbox" id="modal-influential" ${voter.isInfluential || (voter.politics && voter.politics.includes('Influ:')) ? 'checked' : ''} style="width:20px; height:20px;">
                <label style="margin:0; cursor:pointer;" for="modal-influential" style="color:#ef4444; font-weight:bold;">Influential User</label>
            </div>
        </div>
    `;

    document.getElementById('voter-modal').classList.add('flex');
}

function closeModal() {
    document.getElementById('voter-modal').classList.remove('flex');
    currentEditingVoterSerial = null;

    // If we were editing a voter from within the House Manage modal, refresh that modal too
    if (currentEditingHouseId) {
        openHouseManage(currentEditingHouseId);
    } else {
        route(currentRoute);
    }
}

async function saveVoterDetails() {
    if (!currentEditingVoterSerial) return;

    const updates = {
        name: document.getElementById('modal-name').value,
        age: parseInt(document.getElementById('modal-age').value) || 0,
        gender: document.getElementById('modal-gender').value,
        guardian: document.getElementById('modal-guardian').value,
        houseName: document.getElementById('modal-houseName').value,
        politics: document.getElementById('modal-politics').value,
        location: document.getElementById('modal-location').value,
        remarks: document.getElementById('modal-remarks').value,
        vehicleNeeded: document.getElementById('modal-vehicle').checked,
        isInfluential: document.getElementById('modal-influential').checked,
        religion: document.getElementById('modal-religion').value,
        community: document.getElementById('modal-community').value,
        voteType: document.getElementById('modal-voteType').value
    };

    await rtdb.ref(`voters/${currentEditingVoterSerial}`).update(updates);

    // We manually update local state to reflect UI changes across components if sync is slow
    const voter = voters.find(v => v.serialNo === currentEditingVoterSerial);
    if (voter) Object.assign(voter, updates);

    // Auto-update pending house member names if edited mid-house-creation
    const pendingMatch = pendingHouseMembers.find(m => m.serialNo === currentEditingVoterSerial);
    if (pendingMatch) {
        Object.assign(pendingMatch, updates);
        renderPendingHouseMembers();
    }

    closeModal();
}

window.openVoterModal = openVoterModal;

// ---------------------------
// NEW HOUSE MGT HELPERS
// ---------------------------
window.handleLocationChange = function(sno) {
    const loc = document.getElementById(`qh-loc-${sno}`).value;
    const willCheck = document.getElementById(`qh-will-${sno}`);
    if (loc === 'Chittar') {
        willCheck.checked = true;
    } else {
        willCheck.checked = false;
    }
};

let pendingAddMember = null;
window.searchAddMember = function() {
    const sno = parseInt(document.getElementById('house-add-member-search').value);
    const resDiv = document.getElementById('house-add-member-result');
    if (!sno) { resDiv.innerHTML = ''; pendingAddMember = null; return; }
    
    const voter = voters.find(v => v.serialNo === sno);
    if (!voter) {
        resDiv.innerHTML = '<span style="color:#ef4444">Not found</span>';
        pendingAddMember = null;
    } else if (voter.houseId) {
        resDiv.innerHTML = `<span style="color:#f59e0b">Already in ${voter.houseName}</span>`;
        pendingAddMember = null;
    } else {
        resDiv.innerHTML = `<span style="color:var(--success)">Found: ${voter.name}</span>`;
        pendingAddMember = voter;
    }
};

window.executeAddMember = async function() {
    if (!pendingAddMember || !currentEditingHouseId) return;
    const house = houses.find(h => h.id === currentEditingHouseId);
    
    const updates = {};
    updates[`voters/${pendingAddMember.serialNo}/houseId`] = currentEditingHouseId;
    updates[`voters/${pendingAddMember.serialNo}/squad`] = house.squad;
    
    await rtdb.ref().update(updates);
    
    document.getElementById('house-add-member-search').value = '';
    document.getElementById('house-add-member-result').innerHTML = '';
    pendingAddMember = null;
    
    // Refresh the house manage list
    openHouseManage(currentEditingHouseId);
};

window.moveHouse = async function (houseId, direction) {
    const house = houses.find(h => h.id === houseId);
    if (!house) return;

    const squadNum = house.squad;
    const squadHouses = houses.filter(h => h.squad === squadNum).sort((a, b) => (a.order || 0) - (b.order || 0));
    const currentIndex = squadHouses.findIndex(h => h.id === houseId);
    const newIndex = currentIndex + direction;

    if (newIndex < 0 || newIndex >= squadHouses.length) return;

    const targetHouse = squadHouses[newIndex];

    // Swap order
    const updates = {};
    updates[`houses/${houseId}/order`] = newIndex;
    updates[`houses/${targetHouse.id}/order`] = currentIndex;

    // To ensure consistency, we re-sequence all houses in the squad
    squadHouses.splice(currentIndex, 1);
    squadHouses.splice(newIndex, 0, house);

    squadHouses.forEach((h, idx) => {
        updates[`houses/${h.id}/order`] = idx;
    });

    await rtdb.ref().update(updates);
    renderSquadDetails(squadNum);
};
