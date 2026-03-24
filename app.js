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
const POLITICS_OPTIONS = ['Unknown', 'Neutral', 'LDF', 'UDF', 'NDA', 'LDF Influ:', 'UDF Influ:', 'NDA Influ:', 'Neutral Influ:'];
const LOCATION_OPTIONS = ['Chittar', 'Out of Panchayath', 'Out of District', 'Out of Kerala', 'Out of India'];
const RELIGION_OPTS = ['Unknown', 'Hindu', 'Christian', 'Muslim'];
const COMMUNITY_OPTS = {
    'Unknown': ['Unknown'],
    'Hindu': ['Unknown', 'Nair', 'Ezhava', 'Pulaya', 'Paraya', 'Vishwakarma', 'Vellalar'],
    'Christian': ['Unknown', 'Marthomite', 'Jacobite', 'Orthodox', 'MC (Malankara Catholic)', 'Syro-Malabar', 'Latin Catholic', 'CSI', 'Pentecostal'],
    'Muslim': ['Muslim']
};

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
                            community: 'Unknown'
                        };
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
    const el = document.getElementById(`subcat-${rel}`);
    if (el) {
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
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
        <h1 style="display:flex; justify-content:space-between; align-items:center;">
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
                <h3 style="color:var(--text-muted)">Houses Built</h3>
                <h2 style="font-size: 2.5em; color: #f59e0b;">${houses.length}</h2>
            </div>
        </div>
        
        <div class="card grid-cols-4" style="text-align:center; padding-bottom: 5px;">
            <div style="background:var(--bg-color); padding:15px; border-radius:8px; cursor:pointer;" onclick="toggleSubcat('Hindu')">
                <h4 style="color:var(--text-muted)">Hindu</h4><h2 style="color:#ef4444">${hindu.length}</h2>
                ${renderSubCats('Hindu', hindu, '#ef4444')}
            </div>
            <div style="background:var(--bg-color); padding:15px; border-radius:8px; cursor:pointer;" onclick="toggleSubcat('Christian')">
                <h4 style="color:var(--text-muted)">Christian</h4><h2 style="color:#3b82f6">${christian.length}</h2>
                ${renderSubCats('Christian', christian, '#3b82f6')}
            </div>
            <div style="background:var(--bg-color); padding:15px; border-radius:8px; cursor:pointer;" onclick="toggleSubcat('Muslim')">
                <h4 style="color:var(--text-muted)">Muslim</h4><h2 style="color:#10b981">${muslim.length}</h2>
                ${renderSubCats('Muslim', muslim, '#10b981')}
            </div>
            <div style="background:var(--bg-color); padding:15px; border-radius:8px;">
                <h4 style="color:var(--text-muted)">Unknown</h4><h2 style="color:#64748b">${unknown.length}</h2>
            </div>
        </div>
        
        <div class="grid-cols-2">
            <div class="card">
                <h3>Global Search</h3>
                <input type="text" id="global-search" class="form-control" placeholder="Search by Serial No, Name, or House Name..." style="margin-top: 15px;">
                <div id="search-results" style="margin-top: 15px; max-height: 250px; overflow-y: auto;"></div>
            </div>
            <div class="card">
                <h3>Political Breakdown</h3>
                <canvas id="politicsChart" style="max-height: 250px;"></canvas>
            </div>
        </div>
    `;

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

    renderChart();
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
    const ctx = document.getElementById('politicsChart');
    if (!ctx) return;

    const LDFCount = voters.filter(v => v.politics && v.politics.includes('LDF')).length;
    const UDFCount = voters.filter(v => v.politics && v.politics.includes('UDF')).length;
    const NDACount = voters.filter(v => v.politics && v.politics.includes('NDA')).length;
    const OtherCount = voters.length - (LDFCount + UDFCount + NDACount);

    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['LDF', 'UDF', 'NDA', 'Neutral/Unassigned'],
            datasets: [{
                data: [LDFCount, UDFCount, NDACount, OtherCount],
                backgroundColor: ['#ef4444', '#3b82f6', '#f97316', '#cbd5e1']
            }]
        },
        options: { responsive: true, maintainAspectRatio: false }
    });
}

// ---------------------------
// SQUADS & HOUSES
// ---------------------------
function renderSquads() {
    const squadsDiv = document.getElementById('squads');
    squadsDiv.innerHTML = `
        <h1>Squad & House Manager</h1>
        <div class="grid-cols-4" id="squad-tabs">
            ${[1, 2, 3, 4].map(num => `
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
    const squadHouses = houses.filter(h => h.squad === squadNum);

    details.innerHTML = `
        <h2 style="margin-bottom:15px;">Squad ${squadNum} Details</h2>
        <button class="btn btn-success" onclick="openHouseModal(${squadNum})" style="margin-bottom:20px;">+ Create New House</button>
        <div class="grid-cols-3">
            ${squadHouses.map(h => {
        const members = voters.filter(v => v.houseId === h.id);
        return `
                <div class="card" style="cursor:pointer; transition: transform 0.2s;" onclick="openHouseManage('${h.id}')" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='translateY(0)'">
                    <h4>${h.name} <small class="text-muted">(${members.length} members)</small></h4>
                    <p class="text-muted" style="font-size:0.85em; margin-top:8px;">Click to manage members & edit details</p>
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
    const body = document.getElementById('house-edit-body');
    body.innerHTML = `
        <table class="data-table">
            <tr>
                <th style="min-width: 150px;">Member Name</th>
                <th>Religion & Community</th>
                <th>Politics</th>
                <th>Location</th>
                <th>Remarks</th>
                <th style="text-align:center;">Vehicle</th>
                <th style="text-align:center;">Action</th>
            </tr>
            ${members.map(m => `
            <tr>
                <td><strong>#${m.serialNo}</strong> ${m.name}</td>
                <td style="min-width: 160px;">
                    <select id="qh-rel-${m.serialNo}" class="form-control" onchange="handleReligionChange('qh-rel-${m.serialNo}', 'qh-comm-${m.serialNo}')" style="margin-bottom:5px;">
                        ${RELIGION_OPTS.map(opt => `<option value="${opt}" ${(m.religion || 'Unknown') === opt ? 'selected' : ''}>${opt}</option>`).join('')}
                    </select>
                    <select id="qh-comm-${m.serialNo}" class="form-control">
                        ${getCommunityOptions(m.religion || 'Unknown', m.community || 'Unknown')}
                    </select>
                </td>
                <td>
                    <select id="qh-pol-${m.serialNo}" class="form-control">
                        ${POLITICS_OPTIONS.map(opt => `<option value="${opt}" ${(m.politics || 'Unknown') === opt ? 'selected' : ''}>${opt}</option>`).join('')}
                    </select>
                </td>
                <td>
                    <select id="qh-loc-${m.serialNo}" class="form-control">
                        ${LOCATION_OPTIONS.map(opt => `<option value="${opt}" ${(m.location || 'Chittar') === opt ? 'selected' : ''}>${opt}</option>`).join('')}
                    </select>
                </td>
                <td>
                    <input type="text" id="qh-rem-${m.serialNo}" class="form-control" value="${m.remarks || ''}" placeholder="Remarks...">
                </td>
                <td style="text-align:center;">
                    <input type="checkbox" id="qh-veh-${m.serialNo}" ${m.vehicleNeeded ? 'checked' : ''} style="width:18px; height:18px;">
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
    for (let m of members) {
        updates[`voters/${m.serialNo}/politics`] = document.getElementById(`qh-pol-${m.serialNo}`).value;
        updates[`voters/${m.serialNo}/location`] = document.getElementById(`qh-loc-${m.serialNo}`).value;
        updates[`voters/${m.serialNo}/remarks`] = document.getElementById(`qh-rem-${m.serialNo}`).value;
        updates[`voters/${m.serialNo}/vehicleNeeded`] = document.getElementById(`qh-veh-${m.serialNo}`).checked;
        updates[`voters/${m.serialNo}/religion`] = document.getElementById(`qh-rel-${m.serialNo}`).value;
        updates[`voters/${m.serialNo}/community`] = document.getElementById(`qh-comm-${m.serialNo}`).value;
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
    document.getElementById('house-final-rel').value = 'Unknown';
    handleReligionChange('house-final-rel', 'house-final-comm');
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
            <div><strong>#${voter.serialNo} - ${voter.name || 'Unknown'}</strong><br><small>${voter.houseName || 'No original house record'}</small></div>
            <button class="btn btn-success" onclick="addPendingVoter()">Add to List</button>
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
            <span style="color:#ef4444; cursor:pointer; margin-left:5px; font-weight:bold;" onclick="removePendingVoter(${m.serialNo})">✕</span>
        </div>
    `).join('');
}

document.getElementById('modal-create-house-btn').addEventListener('click', async () => {
    if (pendingHouseMembers.length === 0) { alert('Add at least one member!'); return; }
    const finalName = document.getElementById('house-final-name').value.trim();
    if (!finalName) { alert('Provide a house name!'); return; }

    const bulkRel = document.getElementById('house-final-rel').value;
    const bulkComm = document.getElementById('house-final-comm').value;

    const newId = rtdb.ref('houses').push().key;
    const newHouse = { id: newId, name: finalName, squad: currentSquadForHouse };

    const updates = {};
    updates[`houses/${newId}`] = newHouse;
    pendingHouseMembers.forEach(v => {
        updates[`voters/${v.serialNo}/houseId`] = newId;
        updates[`voters/${v.serialNo}/squad`] = currentSquadForHouse;
        if (bulkRel !== 'Unknown') updates[`voters/${v.serialNo}/religion`] = bulkRel;
        if (bulkComm !== 'Unknown') updates[`voters/${v.serialNo}/community`] = bulkComm;
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

    let filtered = voters.filter(v => {
        if (fPol !== 'ALL' && v.politics !== fPol) return false;
        if (fLoc !== 'ALL' && v.location !== fLoc) return false;
        if (fVeh === 'YES' && !v.vehicleNeeded) return false;
        if (fVeh === 'NO' && v.vehicleNeeded) return false;
        if (fPoll === 'YES' && !v.hasPolled) return false;
        if (fPoll === 'NO' && v.hasPolled) return false;
        if (fRel !== 'ALL' && v.religion !== fRel) return false;
        if (fComm !== 'ALL' && v.community !== fComm) return false;
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
                <td>${v.hasPolled ? '✅ Yes' : '❌ No'}</td>
            </tr>
            `).join('')}
        </table>
    `;
}

// ---------------------------
// POLLING DAY
// ---------------------------

window.togglePendingLDF = function (btn) {
    const grid = document.getElementById('unpolled-grid');
    const list = document.getElementById('unpolled-ldf-list');
    const recent = document.getElementById('recent-polled-container');
    if (list.style.display === 'none') {
        grid.style.display = 'none';
        list.style.display = 'block';
        if (recent) recent.style.display = 'none';
        btn.innerHTML = '← Back to All Numbers';
    } else {
        grid.style.display = 'grid';
        list.style.display = 'none';
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
    const pendingLDF = unpolledVoters.filter(v => v.politics && v.politics.includes('LDF'));

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
                <h3 style="color:#64748b;">Neutral</h3>
                <h2 style="font-size:2em;">${neutralPolled}</h2>
            </div>
        </div>
        
        <div style="display:flex; gap:20px; flex-wrap:wrap;">
            <div class="card" id="unpolled-container" style="flex:2; min-width:300px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <h3>Unpolled Voters <small class="text-muted">(${unpolledVoters.length})</small></h3>
                    <button class="btn" style="background:#ef4444; font-size: 0.9em; padding: 5px 15px;" data-original="🔥 Missing LDF (${pendingLDF.length})" onclick="togglePendingLDF(this)">🔥 Missing LDF (${pendingLDF.length})</button>
                </div>
                
                <div class="serial-grid" id="unpolled-grid" style="margin-top:15px;">
                    ${unpolledVoters.map(v => `<div class="serial-btn" id="sbtn-${v.serialNo}" onclick="directPollVoter(${v.serialNo})">${v.serialNo}</div>`).join('')}
                </div>
                
                <div id="unpolled-ldf-list" style="display:none; margin-top:15px; max-height:400px; overflow-y:auto; overflow-x:auto;">
                    <table class="data-table" style="font-size:0.9em;">
                        <tr><th style="padding:10px;">Sl No</th><th>Name</th><th>House</th><th>Location</th><th>Action</th></tr>
                        ${pendingLDF.length === 0 ? '<tr><td colspan="5" style="text-align:center; padding:20px;">All LDF Voters have polled! 🎉</td></tr>' : ''}
                        ${pendingLDF.map(v => `
                            <tr>
                                <td><strong>#${v.serialNo}</strong></td>
                                <td>${v.name || 'Unknown'}</td>
                                <td><small class="text-muted">${v.houseName || '-'}</small></td>
                                <td>${v.location} ${v.vehicleNeeded ? '🚗' : ''}</td>
                                <td><button class="btn btn-success" style="padding:4px 10px; font-size:0.85em;" onclick="directPollVoter(${v.serialNo})">Polled</button></td>
                            </tr>
                        `).join('')}
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
        <div style="margin-bottom: 15px; color: var(--text-muted); font-size: 0.9em;">
            <strong>Guardian:</strong> ${voter.guardian} <br>
            <strong>House:</strong> ${voter.houseName} <br>
            <strong>ID:</strong> ${voter.voterId}
        </div>
        
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
        <div class="form-group" style="display:flex; align-items:center; gap:10px;">
            <input type="checkbox" id="modal-vehicle" ${voter.vehicleNeeded ? 'checked' : ''} style="width:20px; height:20px;">
            <label style="margin:0; cursor:pointer;" for="modal-vehicle">Needs Vehicle on Election Day</label>
        </div>
    `;

    document.getElementById('voter-modal').classList.add('flex');
}

function closeModal() {
    document.getElementById('voter-modal').classList.remove('flex');
    currentEditingVoterSerial = null;
    route(currentRoute);
}

async function saveVoterDetails() {
    if (!currentEditingVoterSerial) return;

    const updates = {
        politics: document.getElementById('modal-politics').value,
        location: document.getElementById('modal-location').value,
        remarks: document.getElementById('modal-remarks').value,
        vehicleNeeded: document.getElementById('modal-vehicle').checked,
        religion: document.getElementById('modal-religion').value,
        community: document.getElementById('modal-community').value
    };

    await rtdb.ref(`voters/${currentEditingVoterSerial}`).update(updates);
    closeModal();
}

window.openVoterModal = openVoterModal;
