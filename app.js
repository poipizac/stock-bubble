// ==========================================================================
// Tide 潮汐 - 前端核心 logic (Vanilla ES6 Javascript)
// ==========================================================================

// 全域狀態
let marketData = null;
let sectorsData = null;
let searchIndexData = null; // 搜尋索引 (輕量，約 100 KB)
let stocksData = null;       // 完整個股歷史資料 (重量，約 30 MB 背景異步加載)
let rankingsData = null;

let pendingModalTicker = null;
let pendingSectorName = null;

let dates = [];
let currentDateIndex = 0;
let modalActiveDate = null;
let isPlaying = false;
let playInterval = null;
let playbackSpeed = 1000; // 毫秒
let selectedBroker = "total"; // total, foreign, trust, dealer
let currentView = "bubble-view";
let activeRankingTab = "buy_total";

// Chart.js 實例
let bubbleChart = null;
let stockChartInstance = null;
let stockTrajectoryChartInstance = null;

// 板塊與色彩對照
const STATUS_COLORS = {
    "漲潮": "#ff4b72",
    "輪動": "#ffb000",
    "觀望": "#8fa0b5",
    "退潮": "#00d2ff"
};

const SECTOR_THEMES = {
    "半導體權值": "#3b82f6",
    "AI 伺服器": "#10b981",
    "液冷與散熱": "#ff4b72",
    "光通訊": "#ffb000",
    "IP與ASIC": "#a855f7",
    "PCB與載板": "#ec4899",
    "重電與綠能": "#f59e0b",
    "海運與物流": "#14b8a6",
    "金控股": "#64748b",
    "車用電子": "#84cc16"
};

// ==========================================================================
// 初始化與資料獲取
// ==========================================================================
document.addEventListener("DOMContentLoaded", async () => {
    try {
        await loadAllData();
        initUI();
        initBubbleChart();
        updateDashboard(dates[currentDateIndex]);
    } catch (error) {
        console.error("初始化資料失敗：", error);
        alert("資料加載失敗，請確保本地已執行 py update_data.py 並正確生成資料目錄。");
    }
});

async function loadAllData() {
    // 獲取數據，並加上防快取時間戳記
    const t = Date.now();
    
    // 1. 同步載入輕量化資料，總體積小於 2 MB，加載時間在毫秒級 (極速頁面初始化)
    const [marketRes, sectorsRes, searchIndexRes, rankingsRes] = await Promise.all([
        fetch(`data/market.json?t=${t}`).then(r => r.json()),
        fetch(`data/sectors.json?t=${t}`).then(r => r.json()),
        fetch(`data/search_index.json?t=${t}`).then(r => r.json()),
        fetch(`data/rankings.json?t=${t}`).then(r => r.json())
    ]);

    marketData = marketRes;
    sectorsData = sectorsRes;
    searchIndexData = searchIndexRes;
    rankingsData = rankingsRes;

    // 前端時間軸改為顯示最新日期的前 10 個工作日
    dates = marketData.all_dates.slice(-10);
    currentDateIndex = dates.length - 1; // 預設指向最新一天

    // 2. 異步在背景加載重量級個股資料庫 (30 MB)，不阻塞 UI 的初始化與搜尋框運作
    fetch(`data/stocks.json?t=${t}`)
        .then(r => {
            if (!r.ok) throw new Error("Stocks database load failed");
            return r.json();
        })
        .then(data => {
            stocksData = data;
            console.log("完整個股籌碼資料庫 (30 MB) 背景加載完成！");
            
            // 如果此時有 pending 的彈窗請求，立即觸發打開
            if (pendingModalTicker) {
                const ticker = pendingModalTicker;
                pendingModalTicker = null;
                showStockDetails(ticker);
            }
            if (pendingSectorName) {
                const secName = pendingSectorName;
                pendingSectorName = null;
                showSectorDetails(secName);
            }
        })
        .catch(err => {
            console.error("個股資料庫背景加載失敗：", err);
        });
}

// ==========================================================================
// UI 初始化與綁定
// ==========================================================================
function initUI() {
    // 設置最新日期標籤
    document.getElementById("latest-date-label").innerText = marketData.date;
    document.getElementById("playback-date-label").innerText = dates[currentDateIndex];

    // 初始化 Timeline Slider 範圍
    const slider = document.getElementById("timeline-slider");
    slider.max = dates.length - 1;
    slider.value = currentDateIndex;

    // 填充時間軸 Ticks 標籤 (只顯示週一的日期)
    const ticksContainer = document.getElementById("timeline-ticks");
    ticksContainer.innerHTML = "";
    for (let i = 0; i < dates.length; i++) {
        const dateObj = new Date(dates[i]);
        // getDay() 為 1 表示週一
        if (dateObj.getDay() === 1) {
            const tick = document.createElement("span");
            tick.className = "tick-label";
            // 轉換為 MM/DD 格式
            const md = dates[i].substring(5).replace("-", "/");
            tick.innerText = md;
            tick.style.left = `${(i / (dates.length - 1)) * 100}%`;
            tick.style.position = "absolute";
            ticksContainer.appendChild(tick);
        }
    }

    // 綁定導航切換
    document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
            e.currentTarget.classList.add("active");
            
            const target = e.currentTarget.getAttribute("data-target");
            switchView(target);
        });
    });

    // 綁定法人分項切換
    document.querySelectorAll("#broker-filter .segment-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            document.querySelectorAll("#broker-filter .segment-btn").forEach(b => b.classList.remove("active"));
            e.currentTarget.classList.add("active");
            selectedBroker = e.currentTarget.getAttribute("data-value");
            
            // 重新繪製泡泡圖
            updateChartData();
        });
    });

    // 綁定時間軸拖動
    slider.addEventListener("input", (e) => {
        currentDateIndex = parseInt(e.target.value);
        document.getElementById("playback-date-label").innerText = dates[currentDateIndex];
        
        // 如果正在播放則暫停
        if (isPlaying) pausePlayback();
        
        updateDashboard(dates[currentDateIndex]);
    });

    // 綁定回放按鈕
    const playBtn = document.getElementById("play-btn");
    playBtn.addEventListener("click", () => {
        if (isPlaying) {
            pausePlayback();
        } else {
            startPlayback();
        }
    });

    // 綁定回放速度切換
    document.querySelectorAll(".play-speed-control .speed-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            document.querySelectorAll(".play-speed-control .speed-btn").forEach(b => b.classList.remove("active"));
            e.currentTarget.classList.add("active");
            playbackSpeed = parseInt(e.currentTarget.getAttribute("data-speed"));
            
            // 如果正在播放，重啟 timer 以套用新速度
            if (isPlaying) {
                pausePlayback();
                startPlayback();
            }
        });
    });

    // 軌跡開關
    document.getElementById("trace-toggle").addEventListener("change", () => {
        updateChartData();
    });

    // 排行榜 Tab 切換
    document.querySelectorAll("#ranking-tabs .rank-tab-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            document.querySelectorAll("#ranking-tabs .rank-tab-btn").forEach(b => b.classList.remove("active"));
            e.currentTarget.classList.add("active");
            activeRankingTab = e.currentTarget.getAttribute("data-rank");
            
            renderRankingsTable();
        });
    });

    // 排行榜搜尋過濾
    document.getElementById("ranking-search-input").addEventListener("input", (e) => {
        renderRankingsTable(e.target.value.trim());
    });

    // 暗黑模式切換
    document.getElementById("theme-toggle").addEventListener("click", () => {
        document.body.classList.toggle("light-theme");
        const icon = document.getElementById("theme-toggle").querySelector("i");
        if (document.body.classList.contains("light-theme")) {
            icon.className = "fa-solid fa-sun";
        } else {
            icon.className = "fa-solid fa-moon";
        }
    });

    // 關閉 Modal
    document.getElementById("modal-close-btn").addEventListener("click", () => {
        document.getElementById("details-modal").style.display = "none";
    });
    
    document.getElementById("details-modal").addEventListener("click", (e) => {
        if (e.target === document.getElementById("details-modal")) {
            document.getElementById("details-modal").style.display = "none";
        }
    });

    // 綁定各股搜尋
    const searchInput = document.getElementById("stock-search-input");
    const clearSearchBtn = document.getElementById("clear-search-btn");
    const dropdown = document.getElementById("search-results-dropdown");

    if (searchInput && dropdown) {
        let activeItemIndex = -1;

        searchInput.addEventListener("input", (e) => {
            const query = e.target.value.trim().toLowerCase();
            if (!query) {
                hideDropdown();
                return;
            }

            if (clearSearchBtn) clearSearchBtn.style.display = "block";

            // 搜尋代號或股名
            const matches = [];
            if (searchIndexData) {
                for (const [ticker, stock] of Object.entries(searchIndexData)) {
                    const code = ticker.split(".")[0];
                    const name = stock.name || "";
                    if (code.includes(query) || name.toLowerCase().includes(query)) {
                        matches.push({ ticker, code, name, sector: stock.sector });
                    }
                }
            }

            // 限制最多顯示 10 筆，避免下拉選單過長
            const limit = 10;
            const sliced = matches.slice(0, limit);

            if (sliced.length === 0) {
                dropdown.innerHTML = `<div class="search-no-results">查無符合個股</div>`;
                dropdown.style.display = "block";
                activeItemIndex = -1;
                return;
            }

            let dropdownHTML = "";
            sliced.forEach((item, idx) => {
                const matchedSector = item.sector || "其他";

                dropdownHTML += `
                    <div class="search-dropdown-item" data-ticker="${item.ticker}" data-index="${idx}">
                        <div class="search-item-info">
                            <span class="search-item-code">${item.code}</span>
                            <span class="search-item-name">${item.name}</span>
                        </div>
                        <span class="search-item-sector">${matchedSector}</span>
                    </div>
                `;
            });

            dropdown.innerHTML = dropdownHTML;
            dropdown.style.display = "block";
            activeItemIndex = -1;

            // 點擊選單項目
            dropdown.querySelectorAll(".search-dropdown-item").forEach(item => {
                item.addEventListener("click", () => {
                    const ticker = item.getAttribute("data-ticker");
                    showStockDetails(ticker);
                    hideDropdown();
                });
            });
        });

        // 鍵盤導航 (上下鍵與 Enter 鍵)
        searchInput.addEventListener("keydown", (e) => {
            const items = dropdown.querySelectorAll(".search-dropdown-item");
            if (dropdown.style.display !== "block" || items.length === 0) return;

            if (e.key === "ArrowDown") {
                e.preventDefault();
                activeItemIndex = (activeItemIndex + 1) % items.length;
                updateActiveItem(items);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                activeItemIndex = (activeItemIndex - 1 + items.length) % items.length;
                updateActiveItem(items);
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (activeItemIndex >= 0 && activeItemIndex < items.length) {
                    const ticker = items[activeItemIndex].getAttribute("data-ticker");
                    showStockDetails(ticker);
                    hideDropdown();
                } else if (items.length > 0) {
                    // 若無選定，直接選取第一個
                    const ticker = items[0].getAttribute("data-ticker");
                    showStockDetails(ticker);
                    hideDropdown();
                }
            } else if (e.key === "Escape") {
                hideDropdown();
            }
        });

        function updateActiveItem(items) {
            items.forEach((item, idx) => {
                if (idx === activeItemIndex) {
                    item.classList.add("active");
                    item.scrollIntoView({ block: "nearest" });
                } else {
                    item.classList.remove("active");
                }
            });
        }

        // 清除按鈕
        if (clearSearchBtn) {
            clearSearchBtn.addEventListener("click", () => {
                searchInput.value = "";
                hideDropdown();
            });
        }

        // 點擊外部關閉選單
        document.addEventListener("click", (e) => {
            if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
                hideDropdown();
            }
        });

        function hideDropdown() {
            dropdown.style.display = "none";
            dropdown.innerHTML = "";
            activeItemIndex = -1;
            if (clearSearchBtn) clearSearchBtn.style.display = "none";
        }
    }

    // 填充白話名詞解釋
    renderGlossary();
}

function switchView(viewId) {
    currentView = viewId;
    document.querySelectorAll(".view-section").forEach(sec => sec.classList.remove("active"));
    document.getElementById(viewId).classList.add("active");

    if (viewId === "ranking-view") {
        renderRankingsTable();
    }
}

// ==========================================================================
// 情緒計與重點更新
// ==========================================================================
function updateDashboard(date) {
    const isLatest = (date === dates[dates.length - 1]);
    
    // 情緒指針更新
    // score 0 樂觀 => 旋轉角度 -90deg，score 100 恐慌 => 旋轉角度 90deg
    const score = isLatest ? marketData.emotion_score : simulateEmotionScore(date);
    const text = isLatest ? marketData.emotion_text : getEmotionText(score);
    
    document.getElementById("emotion-score-num").innerText = score;
    document.getElementById("emotion-text-label").innerText = text;
    
    const deg = ((score / 100) * 180) - 90;
    document.getElementById("gauge-needle").style.transform = `rotate(${deg}deg)`;
    
    // 更新今日重點卡 (如果不是最新日期，則動態渲染該日期的重點)
    const highlightsUl = document.getElementById("highlights-list");
    highlightsUl.innerHTML = "";
    
    const highlights = isLatest ? marketData.today_highlights : generateDynamicHighlights(date);
    highlights.forEach(h => {
        const li = document.createElement("li");
        li.innerText = h;
        highlightsUl.appendChild(li);
    });

    // 更新板塊狀態卡標籤
    updateSectorStatusTags(date);

    // 更新泡泡圖
    updateChartData();
}

function simulateEmotionScore(date) {
    // 基於日期 hash 生成一致的情緒分數
    const seed = hashString(date);
    return Math.floor(25 + (seed % 50)); // 25~75
}

function getEmotionText(score) {
    if (score > 60) return "恐慌";
    if (score < 40) return "樂觀";
    return "中性觀望";
}

function generateDynamicHighlights(date) {
    return [
        `資金於 ${date} 在各大板塊間加速重組。`,
        "半導體權值股發揮撐盤要角，中小型概念股表現分化。",
        "法人在此交易日採取防禦型配置，操作偏向保守。"
    ];
}

function updateSectorStatusTags(date) {
    const dayData = sectorsData.dates_data[date];
    if (!dayData) return;

    const categorizations = { "漲潮": [], "輪動": [], "觀望": [], "退潮": [] };
    
    Object.keys(dayData).forEach(secName => {
        const status = dayData[secName][selectedBroker].status;
        if (categorizations[status]) {
            categorizations[status].push(secName);
        }
    });

    const statusMap = {
        "rising": "漲潮",
        "rotating": "輪動",
        "watching": "觀望",
        "falling": "退潮"
    };

    Object.keys(statusMap).forEach(key => {
        const container = document.getElementById(`sec-tags-${key}`);
        container.innerHTML = "";
        const list = categorizations[statusMap[key]];
        
        if (list.length === 0) {
            container.innerHTML = `<span class="sec-tag-empty" style="font-size:0.75rem;color:var(--text-tertiary);">無板塊</span>`;
        } else {
            list.forEach(name => {
                const tag = document.createElement("span");
                tag.className = "sec-tag";
                tag.innerText = name;
                tag.addEventListener("click", () => showSectorDetails(name));
                container.appendChild(tag);
            });
        }
    });
}

// ==========================================================================
// Chart.js 泡泡圖邏輯 (含軌跡渲染)
// ==========================================================================
function initBubbleChart() {
    const ctx = document.getElementById("sectorBubbleChart").getContext("2d");
    
    // 自訂 Chart.js plugin：在泡泡內部/上方繪製文字標籤
    const sectorLabelsPlugin = {
        id: "sectorLabels",
        afterDatasetsDraw(chart, args, options) {
            const { ctx } = chart;
            ctx.save();
            
            chart.data.datasets.forEach((dataset, datasetIndex) => {
                const meta = chart.getDatasetMeta(datasetIndex);
                if (meta.hidden) return;
                
                // 只在板塊主泡泡 (非軌跡線) 渲染文字
                if (dataset.isTraceDataset) return;

                meta.data.forEach((element, index) => {
                    const dataPoint = dataset.data[index];
                    const label = dataPoint.label || "";
                    
                    const { x, y } = element.tooltipPosition();
                    
                    // 設定文字樣式
                    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
                    ctx.font = "bold 11px 'Noto Sans TC', sans-serif";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    
                    // 加陰影以防背景泡泡顏色影響辨識
                    ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
                    ctx.shadowBlur = 4;
                    ctx.shadowOffsetX = 1;
                    ctx.shadowOffsetY = 1;
                    
                    // 繪製板塊文字 (垂直微調偏移)
                    ctx.fillText(label, x, y);
                });
            });
            ctx.restore();
        }
    };

    bubbleChart = new Chart(ctx, {
        type: "bubble",
        data: {
            datasets: []
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: { top: 20, bottom: 20, left: 20, right: 20 }
            },
            scales: {
                x: {
                    grid: {
                        color: (context) => context.tick.value === 0 ? "rgba(255, 255, 255, 0.25)" : "rgba(255, 255, 255, 0.03)",
                        lineWidth: (context) => context.tick.value === 0 ? 2 : 1,
                        borderDash: (context) => context.tick.value === 0 ? [] : [4, 4]
                    },
                    title: {
                        display: true,
                        text: "資金流向強度 (近 5 日累計買賣超 億新台幣)",
                        color: "rgba(255, 255, 255, 0.85)",
                        font: { size: 11, weight: "bold" }
                    },
                    ticks: {
                        color: "rgba(255, 255, 255, 0.7)",
                        callback: (val) => `${val > 0 ? "+" : ""}${val}億`
                    }
                },
                y: {
                    grid: {
                        color: (context) => context.tick.value === 0 ? "rgba(255, 255, 255, 0.25)" : "rgba(255, 255, 255, 0.03)",
                        lineWidth: (context) => context.tick.value === 0 ? 2 : 1,
                        borderDash: (context) => context.tick.value === 0 ? [] : [4, 4]
                    },
                    title: {
                        display: true,
                        text: "加速 / 放緩力道 (億新台幣 / 天)",
                        color: "rgba(255, 255, 255, 0.85)",
                        font: { size: 11, weight: "bold" }
                    },
                    ticks: {
                        color: "rgba(255, 255, 255, 0.7)",
                        callback: (val) => `${val > 0 ? "+" : ""}${val}億`
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const raw = context.raw;
                            return `${raw.label} (5日流向:${raw.amount > 0 ? '+' : ''}${raw.amount}億)`;
                        }
                    }
                }
            },
            onClick: (e) => {
                const points = bubbleChart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
                if (points.length) {
                    const datasetIndex = points[0].datasetIndex;
                    const index = points[0].index;
                    const dataset = bubbleChart.data.datasets[datasetIndex];
                    if (dataset.isTraceDataset) return;
                    
                    const sectorName = dataset.data[index].label;
                    showSectorDetails(sectorName);
                }
            }
        },
        plugins: [sectorLabelsPlugin]
    });
}

function updateChartData() {
    if (!bubbleChart) return;
    
    const date = dates[currentDateIndex];
    const dayData = sectorsData.dates_data[date];
    if (!dayData) return;

    const showTrace = document.getElementById("trace-toggle").checked;
    
    // 定義象限對應顏色 (與 Tide 網頁完全相符)
    const STATUS_COLORS = {
        "漲潮": "#D85A30",   // 橘紅
        "輪動": "#E4B125",   // 黃色
        "觀望": "#52637a",   // 灰色
        "退潮": "#1D9E75"    // 綠色
    };

    const traceDatasets = [];

    // 1. 如果有開啟軌跡線
    if (showTrace) {
        // 取最近 5 天的歷史
        const historyLength = 5;
        const currentIdx = dates.indexOf(date);
        const startIdx = Math.max(0, currentIdx - historyLength + 1);
        const subDates = dates.slice(startIdx, currentIdx + 1);

        // 為每個板塊繪製一條軌跡線
        Object.keys(sectorsData.sector_mapping).forEach(secName => {
            const points = [];
            let lastStatus = "觀望";
            
            subDates.forEach((d, idx) => {
                const secDay = sectorsData.dates_data[d][secName];
                if (secDay) {
                    const brokerVal = secDay[selectedBroker];
                    points.push({
                        x: brokerVal.x,
                        y: brokerVal.y,
                        r: 2
                    });
                    if (idx === subDates.length - 1) {
                        lastStatus = brokerVal.status || "觀望";
                    }
                }
            });

            if (points.length > 1) {
                const color = STATUS_COLORS[lastStatus] || "#ffffff";
                traceDatasets.push({
                    type: "line",
                    label: `${secName} 軌跡`,
                    data: points,
                    fill: false,
                    borderColor: `${color}77`, // 軌跡用淡色
                    borderWidth: 1.5,
                    borderDash: [2, 2],
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    isTraceDataset: true,
                    tension: 0.1,
                    order: 2 // 背景層
                });
            }
        });
    }

    // 2. 繪製最新的主泡泡 Dataset (Bubble Dataset)
    const mainBubblePoints = [];
    const mainBubbleColors = [];
    const mainBubbleBorderColors = [];

    Object.keys(sectorsData.sector_mapping).forEach(secName => {
        const secDay = dayData[secName];
        if (!secDay) return;
        
        const brokerVal = secDay[selectedBroker];
        mainBubblePoints.push({
            x: brokerVal.x,
            y: brokerVal.y,
            r: brokerVal.r,
            label: secName,
            amount: brokerVal.amount,
            amount_20: brokerVal.amount_20
        });

        // 動態使用當前象限顏色
        const status = brokerVal.status || "觀望";
        const themeColor = STATUS_COLORS[status] || "#52637a";
        mainBubbleColors.push(`${themeColor}aa`); // 填滿色 (加深透明度)
        mainBubbleBorderColors.push(themeColor);   // 邊框色
    });

    // 3. 尋找或建立主泡泡 dataset 以便進行數值漸變線性移動
    let mainDataset = bubbleChart.data.datasets.find(d => d.isTraceDataset === false);
    if (mainDataset) {
        mainDataset.data = mainBubblePoints;
        mainDataset.backgroundColor = mainBubbleColors;
        mainDataset.borderColor = mainBubbleBorderColors;
    } else {
        mainDataset = {
            type: "bubble",
            label: "今日板塊狀態",
            data: mainBubblePoints,
            backgroundColor: mainBubbleColors,
            borderColor: mainBubbleBorderColors,
            borderWidth: 2,
            isTraceDataset: false,
            order: 1 // 上方層
        };
    }

    // 4. 重組 datasets，確保泡泡在上方
    bubbleChart.data.datasets = [...traceDatasets, mainDataset];
    
    // 5. 使用漸變動畫更新，讓泡泡進行線性游動而非爆炸展開
    bubbleChart.update({
        duration: isPlaying ? playbackSpeed * 0.9 : 300, // 播放時配合播放速度線性滑動
        easing: 'easeOutQuad'
    });
}

// ==========================================================================
// 播放控制器邏輯
// ==========================================================================
function startPlayback() {
    isPlaying = true;
    document.getElementById("play-btn").innerHTML = `<i class="fa-solid fa-pause"></i>`;
    
    // 如果已經在最後一天，點播放就回滾到第一天開始
    if (currentDateIndex === dates.length - 1) {
        currentDateIndex = 0;
        document.getElementById("timeline-slider").value = 0;
        document.getElementById("playback-date-label").innerText = dates[currentDateIndex];
        updateDashboard(dates[currentDateIndex]);
    }

    playInterval = setInterval(() => {
        currentDateIndex++;
        if (currentDateIndex >= dates.length) {
            pausePlayback();
            currentDateIndex = dates.length - 1;
            return;
        }

        document.getElementById("timeline-slider").value = currentDateIndex;
        document.getElementById("playback-date-label").innerText = dates[currentDateIndex];
        updateDashboard(dates[currentDateIndex]);
    }, playbackSpeed);
}

function pausePlayback() {
    isPlaying = false;
    document.getElementById("play-btn").innerHTML = `<i class="fa-solid fa-play"></i>`;
    clearInterval(playInterval);
}

// ==========================================================================
// 排行榜渲染邏輯
// ==========================================================================
function renderRankingsTable(searchQuery = "") {
    const list = rankingsData[activeRankingTab];
    const tbody = document.getElementById("ranking-table-body");
    tbody.innerHTML = "";
    
    if (!list || list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="loading-td">查無相關排行數據</td></tr>`;
        return;
    }

    // 過濾搜尋
    let filteredList = list;
    if (searchQuery) {
        const query = searchQuery.toLowerCase();
        // 如果是特定排行榜，可能需要過濾全榜 stock_detail_json
        // 這裡我們先直接過濾當前選中的清單
        filteredList = list.filter(item => 
            item.name.toLowerCase().includes(query) || 
            item.ticker.replace(".TW", "").replace(".TWO", "").includes(query)
        );
    }

    if (filteredList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="loading-td">查無搜尋標的</td></tr>`;
        return;
    }

    filteredList.forEach((item, index) => {
        const tr = document.createElement("tr");
        
        const rank = index + 1;
        const changeSign = item.change_pct > 0 ? "+" : "";
        const changeClass = item.change_pct > 0 ? "txt-up" : (item.change_pct < 0 ? "txt-down" : "txt-neutral");
        const netAmt = item.net_total;
        const netAmtClass = netAmt > 0 ? "txt-up" : (netAmt < 0 ? "txt-down" : "txt-neutral");
        
        const cleanTicker = item.ticker.split(".")[0];
        
        // 放量徽章
        const volRatio = item.volume / item.ma20_volume;
        const volBadge = volRatio >= 2.0 ? `<span class="vol-heavy-badge">▼爆量</span>` : "";

        tr.innerHTML = `
            <td class="rank-num">${rank}</td>
            <td>
                <div class="stock-info-td">
                    <span class="name">${item.name}</span>
                    <span class="code">${cleanTicker}</span>
                </div>
            </td>
            <td style="font-family:'Outfit',sans-serif;font-weight:600;">${item.close}</td>
            <td class="${changeClass}">${changeSign}${item.change_pct}%</td>
            <td class="${netAmtClass}">${netAmt > 0 ? '+' : ''}${netAmt.toLocaleString()}</td>
            <td style="font-family:'Outfit',sans-serif;">${volRatio.toFixed(2)}${volBadge}</td>
            <td style="font-family:'Outfit',sans-serif;">${item.total_stay > 0 ? '+' : ''}${item.total_stay}天</td>
            <td style="font-family:'Outfit',sans-serif;">${item.foreign_share_ratio}%</td>
            <td style="font-family:'Outfit',sans-serif;">${item.large_share_ratio}%</td>
            <td><button class="btn-detail" data-ticker="${item.ticker}">籌碼詳情</button></td>
        `;

        // 點擊事件：跳出 Modal
        tr.querySelector(".btn-detail").addEventListener("click", (e) => {
            e.stopPropagation();
            showStockDetails(item.ticker);
        });
        tr.addEventListener("click", () => showStockDetails(item.ticker));

        tbody.appendChild(tr);
    });
}

// ==========================================================================
// 板塊成分股詳情彈窗
// ==========================================================================
function showSectorDetails(sectorName) {
    const modal = document.getElementById("details-modal");
    const container = document.getElementById("modal-body-content");
    
    // 如果完整個股資料庫 (30 MB) 還在背景加載中，顯示玻璃擬態加載畫面，並標記為 pending
    if (!stocksData) {
        pendingSectorName = sectorName;
        modal.style.display = "flex";
        container.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:100px 0; color:var(--text-secondary);">
                <i class="fa-solid fa-spinner fa-spin" style="font-size:2.5rem; margin-bottom:20px; color:var(--accent-color);"></i>
                <div style="font-size:1.1rem; font-weight:600;">正在加載台股完整資料庫 (30 MB)...</div>
                <div style="font-size:0.85rem; color:var(--text-tertiary); margin-top:8px;">首次進入網頁下載較多歷史價量，請稍候。</div>
            </div>
        `;
        return;
    }
    
    const tickers = sectorsData.sector_mapping[sectorName];
    if (!tickers) return;

    // 當前選定的歷史日期板塊狀態
    const currentDate = dates[currentDateIndex];
    const secStatus = sectorsData.dates_data[currentDate][sectorName].total;

    let rowsHTML = "";
    tickers.forEach((t, index) => {
        const stock = stocksData[t];
        if (!stock) return;
        
        // 從歷史中尋找當日數據，若無則 fallback 到最新
        const info = stock.history.find(h => h.date === currentDate) || stock.info;
        const changeSign = info.change_pct > 0 ? "+" : "";
        const changeClass = info.change_pct > 0 ? "txt-up" : (info.change_pct < 0 ? "txt-down" : "txt-neutral");
        const netAmtClass = info.net_total > 0 ? "txt-up" : (info.net_total < 0 ? "txt-down" : "txt-neutral");
        
        rowsHTML += `
            <tr data-ticker="${t}">
                <td style="font-weight:600;">${stock.name} (${t.split(".")[0]})</td>
                <td style="font-family:'Outfit',sans-serif;font-weight:600;">${info.close}</td>
                <td class="${changeClass}">${changeSign}${info.change_pct}%</td>
                <td class="${netAmtClass}">${info.net_total > 0 ? '+' : ''}${info.net_total}</td>
                <td style="font-family:'Outfit',sans-serif;">${info.total_stay > 0 ? '+' : ''}${info.total_stay}天</td>
                <td style="font-family:'Outfit',sans-serif;">${info.avg_cost_20 ? info.avg_cost_20 : '--'}</td>
                <td style="font-family:'Outfit',sans-serif;">${info.foreign_share_ratio}%</td>
                <td><button class="btn-detail-modal btn-detail" data-ticker="${t}">籌碼圖</button></td>
            </tr>
        `;
    });

    container.innerHTML = `
        <div class="sector-detail-header">
            <div>
                <h2>${sectorName} <span>板塊成份股</span></h2>
                <p style="font-size:0.85rem;color:var(--text-secondary);margin-top:4px;">
                    板塊於 ${currentDate} 定位：<span style="color:var(--color-${secStatus.status === '漲潮' ? 'rising' : (secStatus.status === '輪動' ? 'rotating' : (secStatus.status === '退潮' ? 'falling' : 'watching'))});font-weight:bold;">${secStatus.status}</span> 
                    (5日流超 ${secStatus.amount > 0 ? '+' : ''}${secStatus.amount} 億)
                </p>
            </div>
        </div>
        
        <div class="modal-full-layout">
            <div class="glass-card" style="padding:0;overflow:hidden;border:1px solid var(--glass-border);">
                <div class="table-container">
                    <table class="ranking-table">
                        <thead>
                            <tr>
                                <th>成分股名稱 (代號)</th>
                                <th>當日收盤價</th>
                                <th>當日漲跌幅</th>
                                <th>當日法人買賣超 (百萬)</th>
                                <th>當日資金停留天數</th>
                                <th>當日20日法人均價</th>
                                <th>當日外資持股比</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHTML}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;

    // 綁定成分股點擊
    container.querySelectorAll(".btn-detail-modal").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const ticker = e.currentTarget.getAttribute("data-ticker");
            showStockDetails(ticker);
        });
    });

    modal.style.display = "flex";
}

// ==========================================================================
// 個股詳細籌碼彈窗 (含 K線+買超 與 軌跡圖)
// ==========================================================================
function showStockDetails(ticker, isDateSwitch = false) {
    const modal = document.getElementById("details-modal");
    const container = document.getElementById("modal-body-content");
    
    // 如果完整個股資料庫 (30 MB) 還在背景加載中，顯示玻璃擬態加載畫面，並標記為 pending
    if (!stocksData) {
        pendingModalTicker = ticker;
        modal.style.display = "flex";
        container.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:100px 0; color:var(--text-secondary);">
                <i class="fa-solid fa-spinner fa-spin" style="font-size:2.5rem; margin-bottom:20px; color:var(--accent-color);"></i>
                <div style="font-size:1.1rem; font-weight:600;">正在加載台股完整資料庫 (30 MB)...</div>
                <div style="font-size:0.85rem; color:var(--text-tertiary); margin-top:8px;">首次進入網頁下載較多歷史價量，請稍候。</div>
            </div>
        `;
        return;
    }
    
    const stock = stocksData[ticker];
    if (!stock) return;

    // 檢查原本 active 的 Tab，避免日期切換時被 reset 回 K線圖
    let activeTab = "kline";
    const trajTabBtn = container.querySelector("#tab-btn-traj");
    if (trajTabBtn && trajTabBtn.classList.contains("active")) {
        activeTab = "traj";
    }

    // 初始化/設定 Modal 的活動日期源頭
    if (!isDateSwitch) {
        modalActiveDate = dates[currentDateIndex];
    }

    // 依據當前選定的歷史日期載入指標數值
    const currentDate = modalActiveDate || dates[currentDateIndex];
    const info = stock.history.find(h => h.date === currentDate) || stock.info;
    const currentHistIndex = stock.history.findIndex(h => h.date === currentDate);
    
    const changeSign = info.change_pct > 0 ? "+" : "";
    const changeClass = info.change_pct > 0 ? "txt-up" : (info.change_pct < 0 ? "txt-down" : "txt-neutral");
    
    // 生成徽章 HTML
    let badgesHTML = "";
    if (info.is_heavy_buy) badgesHTML += `<span class="badge badge-heavy-buy">🔥 主力異常大買</span>`;
    if (info.is_heavy_sell) badgesHTML += `<span class="badge badge-heavy-sell">⚠️ 主力異常大賣</span>`;
    if (info.total_stay >= 3) badgesHTML += `<span class="badge badge-streak">📈 資金連買 ${info.total_stay} 天</span>`;
    if (info.is_buy_on_dip) badgesHTML += `<span class="badge badge-streak" style="background:rgba(245,158,11,0.15);color:#fbbf24;border-color:rgba(245,158,11,0.3);">💎 越跌越買</span>`;

    // 如果只是點擊前一日/後一日切換日期，做局部更新即可，以保留 Canvas 並觸發 Chart.js 線性更新動畫
    if (isDateSwitch) {
        // 1. 更新 Header 資訊
        const badgesContainer = container.querySelector(".stock-detail-badges");
        if (badgesContainer) badgesContainer.innerHTML = badgesHTML;
        
        const priceEl = document.getElementById("modal-stock-price");
        if (priceEl) priceEl.textContent = info.close;
        
        const changeEl = document.getElementById("modal-stock-change");
        if (changeEl) {
            changeEl.className = changeClass;
            changeEl.textContent = `${changeSign}${info.change_pct}%`;
        }
        
        const dateEl = document.getElementById("modal-stock-date");
        if (dateEl) dateEl.textContent = currentDate;

        // 2. 更新按鈕樣式與狀態
        const prevDateBtn = container.querySelector("#btn-modal-prev-date");
        const nextDateBtn = container.querySelector("#btn-modal-next-date");
        if (prevDateBtn) {
            if (currentHistIndex <= 0) {
                prevDateBtn.style.opacity = "0.3";
                prevDateBtn.style.cursor = "not-allowed";
            } else {
                prevDateBtn.style.opacity = "1.0";
                prevDateBtn.style.cursor = "pointer";
            }
        }
        if (nextDateBtn) {
            if (currentHistIndex >= stock.history.length - 1) {
                nextDateBtn.style.opacity = "0.3";
                nextDateBtn.style.cursor = "not-allowed";
            } else {
                nextDateBtn.style.opacity = "1.0";
                nextDateBtn.style.cursor = "pointer";
            }
        }

        // 3. 更新 6 個小卡數值
        // 20日均價
        const avgCostBox = document.getElementById("modal-stat-avg-cost");
        if (avgCostBox) {
            avgCostBox.querySelector(".val").textContent = info.avg_cost_20 ? info.avg_cost_20 : '--';
            avgCostBox.querySelector(".sub").textContent = info.avg_cost_20 ? `當日價格高於均價：${info.close > info.avg_cost_20 ? '是 (偏多)' : '否 (偏空)'}` : '無定位';
        }
        // 月線位置
        const ma20Box = document.getElementById("modal-stat-ma20");
        if (ma20Box) {
            ma20Box.querySelector(".val").innerHTML = info.is_above_ma20 ? '<span class="txt-up">站上月線</span>' : '<span class="txt-down">月線下方</span>';
        }
        // 三大法人買超
        const chipBox = document.getElementById("modal-stat-chip");
        if (chipBox) {
            const valEl = chipBox.querySelector(".val");
            valEl.className = `val ${info.net_total > 0 ? 'txt-up' : (info.net_total < 0 ? 'txt-down' : '')}`;
            valEl.textContent = `${info.net_total > 0 ? '+' : ''}${info.net_total}`;
            chipBox.querySelector(".sub").innerHTML = `外資: ${info.net_foreign > 0 ? '+' : ''}${Math.round(info.net_foreign)} | 投信: ${info.net_trust > 0 ? '+' : ''}${Math.round(info.net_trust)} | 自營: ${info.net_dealer > 0 ? '+' : ''}${Math.round(info.net_dealer)}`;
        }
        // 當沖率
        const daytradeBox = document.getElementById("modal-stat-daytrade");
        if (daytradeBox) {
            daytradeBox.querySelector(".val").textContent = `${info.daytrade_ratio}%`;
        }
        // 外資持股比
        const foreignBox = document.getElementById("modal-stat-foreign");
        if (foreignBox) {
            foreignBox.querySelector(".val").textContent = `${info.foreign_share_ratio}%`;
            foreignBox.querySelector(".sub").textContent = `外資停留天數：${info.foreign_stay > 0 ? '+' : ''}${info.foreign_stay}天`;
        }
        // 大戶持股
        const largeBox = document.getElementById("modal-stat-large");
        if (largeBox) {
            largeBox.querySelector(".val").textContent = `${info.large_share_ratio}%`;
        }

        // 4. 觸發 Canvas 圖表局部更新
        if (activeTab === "traj") {
            renderStockTrajectoryChart(stock);
        } else {
            renderStockHistoryChart(stock);
        }
        return;
    }

    container.innerHTML = `
        <div class="stock-detail-header">
            <div class="stock-title-info">
                <h2>${stock.name} <span>${ticker.split(".")[0]}</span></h2>
                <div class="stock-detail-badges">
                    ${badgesHTML}
                </div>
            </div>
            <div style="text-align:right;">
                <div id="modal-stock-price" style="font-size:1.8rem;font-weight:700;font-family:'Outfit',sans-serif;line-height:1.1;">${info.close}</div>
                <div id="modal-stock-change" class="${changeClass}" style="font-size:0.95rem;font-weight:600;">${changeSign}${info.change_pct}%</div>
                <div class="modal-date-picker-row" style="margin-top:5px; display:flex; align-items:center; justify-content:flex-end; gap:6px;">
                    <button class="btn-modal-date" id="btn-modal-prev-date" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15); color:#ffffff; border-radius:4px; padding:2px 6px; font-size:0.7rem; cursor:pointer;" title="前一日"><i class="fa-solid fa-chevron-left"></i> 前一日</button>
                    <span id="modal-stock-date" style="font-size:0.75rem;color:var(--text-secondary);font-weight:bold;margin:0 2px;">${currentDate}</span>
                    <button class="btn-modal-date" id="btn-modal-next-date" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15); color:#ffffff; border-radius:4px; padding:2px 6px; font-size:0.7rem; cursor:pointer;" title="後一日">後一日 <i class="fa-solid fa-chevron-right"></i></button>
                </div>
            </div>
        </div>

        <div class="modal-grid-layout">
            <!-- 左側指標小卡 -->
            <div class="stock-stats-grid">
                <div class="stat-box" id="modal-stat-avg-cost">
                    <div class="label">20日法人加碼均價</div>
                    <div class="val" style="color:#fbbf24;">${info.avg_cost_20 ? info.avg_cost_20 : '--'}</div>
                    <div class="sub">當日價格高於均價：${info.avg_cost_20 ? (info.close > info.avg_cost_20 ? '是 (偏多)' : '否 (偏空)') : '無定位'}</div>
                </div>
                <div class="stat-box" id="modal-stat-ma20">
                    <div class="label">月線位置 (MA20)</div>
                    <div class="val">${info.is_above_ma20 ? '<span class="txt-up">站上月線</span>' : '<span class="txt-down">月線下方</span>'}</div>
                    <div class="sub">月均成本防守參考</div>
                </div>
                <div class="stat-box" id="modal-stat-chip">
                    <div class="label">當日三大法人買超</div>
                    <div class="val ${info.net_total > 0 ? 'txt-up' : (info.net_total < 0 ? 'txt-down' : '')}">
                        ${info.net_total > 0 ? '+' : ''}${info.net_total}
                    </div>
                    <div class="sub" style="font-size:0.7rem;color:var(--text-secondary);">外資: ${info.net_foreign > 0 ? '+' : ''}${Math.round(info.net_foreign)} | 投信: ${info.net_trust > 0 ? '+' : ''}${Math.round(info.net_trust)} | 自營: ${info.net_dealer > 0 ? '+' : ''}${Math.round(info.net_dealer)}</div>
                </div>
                <div class="stat-box" id="modal-stat-daytrade">
                    <div class="label">當日當沖比率</div>
                    <div class="val">${info.daytrade_ratio}%</div>
                    <div class="sub">當日當沖張數 / 當日總成交量</div>
                </div>
                <div class="stat-box" id="modal-stat-foreign">
                    <div class="label">當日外資持股比率</div>
                    <div class="val">${info.foreign_share_ratio}%</div>
                    <div class="sub">外資停留天數：${info.foreign_stay > 0 ? '+' : ''}${info.foreign_stay}天</div>
                </div>
                <div class="stat-box" id="modal-stat-large">
                    <div class="label">當日千張大戶持股</div>
                    <div class="val">${info.large_share_ratio}%</div>
                    <div class="sub">籌碼集中度參考</div>
                </div>
            </div>

            <!-- 右側圖表區域與 Tabs -->
            <div class="glass-card" style="padding:15px;display:flex;flex-direction:column;">
                <div class="modal-tabs">
                    <button class="modal-tab-btn active" id="tab-btn-kline">歷史K線與法人籌碼</button>
                    <button class="modal-tab-btn" id="tab-btn-traj">個股資金軌跡圖</button>
                </div>
                
                <div class="modal-tab-panel active" id="panel-kline">
                    <div class="modal-chart-container">
                        <canvas id="stockHistoryChart"></canvas>
                    </div>
                </div>
                
                <div class="modal-tab-panel" id="panel-traj">
                    <div class="modal-chart-container">
                        <canvas id="stockTrajectoryChart"></canvas>
                    </div>
                </div>
            </div>
        </div>
    `;

    // 綁定 Tabs 切換
    const kBtn = container.querySelector("#tab-btn-kline");
    const tBtn = container.querySelector("#tab-btn-traj");
    const kPanel = container.querySelector("#panel-kline");
    const tPanel = container.querySelector("#panel-traj");

    kBtn.addEventListener("click", () => {
        kBtn.classList.add("active");
        tBtn.classList.remove("active");
        kPanel.classList.add("active");
        tPanel.classList.remove("active");
        renderStockHistoryChart(stock);
    });

    tBtn.addEventListener("click", () => {
        tBtn.classList.add("active");
        kBtn.classList.remove("active");
        tPanel.classList.add("active");
        kPanel.classList.remove("active");
        renderStockTrajectoryChart(stock);
    });

    // 綁定前一日/後一日日期切換按鈕
    const prevDateBtn = container.querySelector("#btn-modal-prev-date");
    const nextDateBtn = container.querySelector("#btn-modal-next-date");

    // 設定初始按鈕禁用樣式
    if (currentHistIndex <= 0) {
        prevDateBtn.style.opacity = "0.3";
        prevDateBtn.style.cursor = "not-allowed";
    }
    if (currentHistIndex >= stock.history.length - 1) {
        nextDateBtn.style.opacity = "0.3";
        nextDateBtn.style.cursor = "not-allowed";
    }

    prevDateBtn.addEventListener("click", () => {
        const hist = stock.history;
        const index = hist.findIndex(h => h.date === modalActiveDate);
        if (index <= 0) return;

        const newDate = hist[index - 1].date;
        modalActiveDate = newDate;

        const sliderIndex = dates.indexOf(newDate);
        if (sliderIndex !== -1) {
            currentDateIndex = sliderIndex;
            const slider = document.getElementById("timeline-slider");
            if (slider) slider.value = currentDateIndex;
            const dateLabel = document.getElementById("playback-date-label");
            if (dateLabel) dateLabel.textContent = newDate;
            updateDashboard(newDate);
        } else {
            // 超出首頁 10 天範圍時，將首頁 Slider 鎖定在最左邊 (Index 0)
            const slider = document.getElementById("timeline-slider");
            if (slider) slider.value = 0;
            const dateLabel = document.getElementById("playback-date-label");
            if (dateLabel) dateLabel.textContent = dates[0];
            updateDashboard(dates[0]);
        }
        showStockDetails(ticker, true);
    });

    nextDateBtn.addEventListener("click", () => {
        const hist = stock.history;
        const index = hist.findIndex(h => h.date === modalActiveDate);
        if (index === -1 || index >= hist.length - 1) return;

        const newDate = hist[index + 1].date;
        modalActiveDate = newDate;

        const sliderIndex = dates.indexOf(newDate);
        if (sliderIndex !== -1) {
            currentDateIndex = sliderIndex;
            const slider = document.getElementById("timeline-slider");
            if (slider) slider.value = currentDateIndex;
            const dateLabel = document.getElementById("playback-date-label");
            if (dateLabel) dateLabel.textContent = newDate;
            updateDashboard(newDate);
        } else {
            // 超出首頁 10 天範圍時，將首頁 Slider 鎖定在最左邊 (Index 0)
            const slider = document.getElementById("timeline-slider");
            if (slider) slider.value = 0;
            const dateLabel = document.getElementById("playback-date-label");
            if (dateLabel) dateLabel.textContent = dates[0];
            updateDashboard(dates[0]);
        }
        showStockDetails(ticker, true);
    });

    modal.style.display = "flex";
    
    // 依據先前 active 的 Tab 進行初次渲染與 class 設定
    setTimeout(() => {
        if (activeTab === "traj") {
            const kBtn = container.querySelector("#tab-btn-kline");
            const tBtn = container.querySelector("#tab-btn-traj");
            const kPanel = container.querySelector("#panel-kline");
            const tPanel = container.querySelector("#panel-traj");
            if (kBtn && tBtn && kPanel && tPanel) {
                kBtn.classList.remove("active");
                tBtn.classList.add("active");
                kPanel.classList.remove("active");
                tPanel.classList.add("active");
            }
            renderStockTrajectoryChart(stock);
        } else {
            renderStockHistoryChart(stock);
        }
    }, 100);
}

// 繪製個股歷史 K 線與法人買超
function renderStockHistoryChart(stock) {
    if (stockChartInstance) stockChartInstance.destroy();
    
    const ctx = document.getElementById("stockHistoryChart").getContext("2d");
    const hist = stock.history;

    const labels = hist.map(h => h.date.substring(5)); // 只取 MM-DD
    const prices = hist.map(h => h.close);
    const ma20 = hist.map(h => h.ma20_price);
    const netTotal = hist.map(h => h.net_total);

    // 法人買超顏色 (買超紅，賣超綠)
    const barColors = netTotal.map(val => val >= 0 ? "rgba(239, 68, 68, 0.75)" : "rgba(16, 185, 129, 0.75)");
    const barBorderColors = netTotal.map(val => val >= 0 ? "#ef4444" : "#10b981");

    stockChartInstance = new Chart(ctx, {
        data: {
            labels: labels,
            datasets: [
                {
                    type: "line",
                    label: "收盤價",
                    data: prices,
                    borderColor: "#ffffff",
                    borderWidth: 2,
                    pointRadius: 1,
                    yAxisID: "y-price"
                },
                {
                    type: "line",
                    label: "月線 (MA20)",
                    data: ma20,
                    borderColor: "#fbbf24",
                    borderWidth: 1.5,
                    borderDash: [3, 3],
                    pointRadius: 0,
                    yAxisID: "y-price"
                },
                {
                    type: "bar",
                    label: "法人買賣超 (百萬)",
                    data: netTotal,
                    backgroundColor: barColors,
                    borderColor: barBorderColors,
                    borderWidth: 1.5,
                    yAxisID: "y-chip"
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: "rgba(255, 255, 255, 0.7)", font: { size: 9 } }
                },
                "y-price": {
                    type: "linear",
                    position: "left",
                    grid: { color: "rgba(255,255,255,0.03)" },
                    ticks: { color: "rgba(255, 255, 255, 0.7)", font: { size: 9 } },
                    title: { display: true, text: "股價", color: "rgba(255, 255, 255, 0.85)", font: { size: 9 } }
                },
                "y-chip": {
                    type: "linear",
                    position: "right",
                    grid: { display: false },
                    ticks: { color: "rgba(255, 255, 255, 0.7)", font: { size: 9 } },
                    title: { display: true, text: "買賣超金額 (百萬)", color: "rgba(255, 255, 255, 0.85)", font: { size: 9 } }
                }
            },
            plugins: {
                legend: {
                    labels: { color: "rgba(255, 255, 255, 0.85)", font: { size: 10 } }
                }
            }
        }
    });
}

// 繪製個股 20 日資金軌跡回放圖
function renderStockTrajectoryChart(stock) {
    const canvas = document.getElementById("stockTrajectoryChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const hist = stock.history; // 取最近 20 天繪製軌跡
    
    // 找出當前歷史日期對應的軌跡點索引，藉此動態移動紅圈位置
    const currentDate = modalActiveDate || dates[currentDateIndex];
    const currentHistIndex = hist.findIndex(h => h.date === currentDate);
    const highlightIndex = currentHistIndex !== -1 ? currentHistIndex : hist.length - 1;

    const points = hist.map((h, index) => {
        return {
            x: h.x,
            y: h.y,
            // 點的半徑 (當日放大)
            r: index === highlightIndex ? 8 : 3
        };
    });

    const newColors = hist.map((h, i) => i === highlightIndex ? "#ef4444" : "rgba(59, 130, 246, 0.9)");
    const newRadii = hist.map((h, i) => i === highlightIndex ? 6 : 3);

    // 如果圖表實例已經存在，且 Canvas 沒被銷毀，直接更新屬性以觸發線性平滑過渡動畫，避免整張圖重繪
    if (stockTrajectoryChartInstance && canvas.chart === stockTrajectoryChartInstance) {
        stockTrajectoryChartInstance.data.datasets[0].data = points;
        stockTrajectoryChartInstance.data.datasets[0].pointBackgroundColor = newColors;
        stockTrajectoryChartInstance.data.datasets[0].pointRadius = newRadii;
        stockTrajectoryChartInstance.update({
            duration: 300,
            easing: 'easeOutQuad'
        });
        return;
    }

    // 否則，若是第一次開啟 Modal 或 Canvas 重建了，銷毀舊實例並建立新實例
    if (stockTrajectoryChartInstance) {
        stockTrajectoryChartInstance.destroy();
    }

    const datesLabels = hist.map(h => h.date);

    stockTrajectoryChartInstance = new Chart(ctx, {
        type: "line",
        data: {
            labels: datesLabels,
            datasets: [
                {
                    label: `${stock.name} 資金流向軌跡`,
                    data: points,
                    fill: false,
                    borderColor: "rgba(59, 130, 246, 0.7)",
                    borderWidth: 2,
                    tension: 0.15,
                    pointBackgroundColor: newColors,
                    pointBorderColor: "#ffffff",
                    pointRadius: newRadii,
                    segment: {
                        borderColor: ctx => {
                            // 可選：可以給連線加上漸層
                            return "rgba(59, 130, 246, 0.4)";
                        }
                    }
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: "linear",
                    title: { display: true, text: "資金集中度 % (買超佔成交額比)", color: "rgba(255, 255, 255, 0.85)", font: { size: 10 } },
                    grid: {
                        color: (context) => (context.tick && context.tick.value === 0) ? "rgba(255, 255, 255, 0.45)" : "rgba(255, 255, 255, 0.04)",
                        lineWidth: (context) => (context.tick && context.tick.value === 0) ? 1.8 : 0.8
                    },
                    ticks: { color: "rgba(255, 255, 255, 0.7)", font: { size: 9 } }
                },
                y: {
                    type: "linear",
                    title: { display: true, text: "資金停留天數 (正值連買，負值連賣)", color: "rgba(255, 255, 255, 0.85)", font: { size: 10 } },
                    grid: {
                        color: (context) => (context.tick && context.tick.value === 0) ? "rgba(255, 255, 255, 0.45)" : "rgba(255, 255, 255, 0.04)",
                        lineWidth: (context) => (context.tick && context.tick.value === 0) ? 1.8 : 0.8
                    },
                    ticks: { color: "rgba(255, 255, 255, 0.7)", font: { size: 9 } }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (context) => datesLabels[context[0].dataIndex],
                        label: (context) => {
                            const p = context.raw;
                            return `集中度: ${p.x}% | 停留: ${p.y}天`;
                        }
                    }
                }
            }
        }
    });

    // 將圖表實例綁定到 canvas DOM 元素上，便於後續判定 canvas 是否被重構銷毀
    canvas.chart = stockTrajectoryChartInstance;
}

// ==========================================================================
// 輔助函式：白話名詞百科生成與 Hash
// ==========================================================================
function renderGlossary() {
    const container = document.getElementById("glossary-container");
    container.innerHTML = "";

    const glossary = [
        { title: "三大法人", desc: "「外資、投信、自營商」的合稱。他們是市場中資金最大、影響力最強的機構玩家。跟蹤他們的錢是台股籌碼分析的核心。", icon: "fa-users" },
        { title: "外資", desc: "外國機構投資人（如外資基金、外商投行）。是台股成交量最大的法人，買賣動作具有極強的「持續性」，是權值股漲跌的核心引擎。", icon: "fa-plane-departure" },
        { title: "投信", desc: "國內基金公司（含發行高股息 ETF 基金者）。體量雖比外資小，但近年在 ETF 大熱下影響力暴增，季底有「基金作帳/結帳」行情。", icon: "fa-building-columns" },
        { title: "自營商", desc: "證券商用自己的錢做交易。本系統僅計算其「自行買賣」的淨額，排除與權證避險無關的「避險」雜訊，更能反映自營商主動看多空的態度。", icon: "fa-sack-dollar" },
        { title: "買賣超金額", desc: "在某交易日中「買進總額 − 賣出總額」的淨差額。正數為買超（資金流入）、負數為賣超（資金流出）。金額單位均以百萬新台幣計算。", icon: "fa-arrow-right-arrow-left" },
        { title: "資金停留天數", desc: "三大法人連續「淨買超（正天數）」或連續「淨賣超（負天數）」的天數。天數越大代表法人的操作意願越堅決、越具持續性。", icon: "fa-clock" },
        { title: "漲潮 / 輪動 / 觀望 / 退潮", desc: "本系統基於潮汐原理定義板塊：漲潮（加速流入，最強）；輪動（流入但放緩，主力高機率換股）；觀望（流出但放緩，賣壓減輕）；退潮（加速流出，最弱）。", icon: "fa-water" },
        { title: "20日法人均價", desc: "近 20 天法人合計淨買超的日子，用當日收盤價與買超額進行加權平均。常用來作爲法人這一波加碼建倉的估算成本錨點。", icon: "fa-calculator" },
        { title: "異常大買 / 爆量", desc: "異常大買指法人買超金額大幅高於該股本身的常態水準；爆量指當日成交張數高於 20 日均量的 2 倍以上。兩者常為主力發動訊號。", icon: "fa-bolt-lightning" }
    ];

    glossary.forEach(item => {
        const div = document.createElement("div");
        div.className = "glossary-item";
        div.innerHTML = `
            <h4><i class="fa-solid ${item.icon}"></i> ${item.title}</h4>
            <p>${item.desc}</p>
        `;
        container.appendChild(div);
    });
}

function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash);
}
