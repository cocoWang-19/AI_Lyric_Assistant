
const RAILWAY_URL = 'https://ailyricassistant-production-13a6.up.railway.app'; // 定義公開的 Railway URL

const LOCAL_URL = 'http://localhost:3000'; // 定義本地的 URL
let BACKEND_URL 

// 判斷網頁是否從本地環境或本地檔案加載
if (window.location.hostname === 'localhost' || window.location.protocol === 'file:') {
    BACKEND_URL = LOCAL_URL;
    console.log(`[Env] 偵測到本地環境，使用: ${LOCAL_URL}`);
} else {
    // 否則使用 Railway 公開 URL
    BACKEND_URL = RAILWAY_URL;
    console.log(`[Env] 偵測到雲端環境，使用: ${RAILWAY_URL}`);
}

let currentGender = 'FEMALE'; // 預設值
const FEMALE_VOICE = 'FEMALE';
const MALE_VOICE = 'MALE';

function updateGenderButtons(selectedGender) {
    // 清除所有按鈕的 active 狀態
    const buttons = document.querySelectorAll('#tts-gender-selection button');
    buttons.forEach(btn => btn.classList.remove('active'));

    // 根據選中的性別，將 active 類別加到正確的按鈕上
    if (selectedGender === 'RANDOM') {
        // 隨機模式下，不特別標示單一性別按鈕
    } else {
        const targetId = `gender-${selectedGender.toLowerCase()}`;
        const targetButton = document.getElementById(targetId);
        if (targetButton) {
            targetButton.classList.add('active');
        }
    }
}

// 處理按鈕點擊的函數
function setGender(gender) {
    if (gender === 'RANDOM') {
        // 1. 實現隨機切換
        currentGender = Math.random() < 0.5 ? MALE_VOICE : FEMALE_VOICE;
        console.log(`[Gender] 隨機選擇了: ${currentGender}`);
    } else {
        // 2. 手動選擇
        currentGender = gender;
    }
    
    // 3. 更新介面樣式
    updateGenderButtons(currentGender);
}

async function analyzeLyrics() {
    const lyrics = document.getElementById('lyricsInput').value.trim();
    const statusDiv = document.getElementById('status');
    const resultsPre = document.getElementById('results');
    const audioPlayerDiv = document.getElementById('audio-player'); // 在頂部定義一次

    // 1.檢查輸入
    if (!lyrics) {
        statusDiv.textContent = "請輸入歌詞才能分析！";
        statusDiv.className = 'error';
        resultsPre.textContent = '';
        return;
    }

    // 2.更新狀態並發送請求
    statusDiv.textContent = "正在發送請求給後端 AI... 請稍候...";
    statusDiv.className = '';
    resultsPre.textContent = '分析中...';
    audioPlayerDiv.innerHTML = '（音頻播放器將在分析完成後出現）'; // 清空舊的播放器

    try {
        const response = await fetch(`${BACKEND_URL}/lyrics`, {
            method: 'POST',
            headers: {
            //告訴後端，我發送的是 JSON 格式
            'Content-Type': 'application/json' 
            },
            //將歌詞打包成 JSON 格式發送
            body: JSON.stringify({ lyrics: lyrics,
                //從全域變數中讀取最新的性別狀態
                gender: currentGender
             })    
        }); 



        // 檢查 HTTP 狀態碼是否成功 (200-299)
        if (!response.ok) {
          let errorText;
        try {
         errorText = await response.text();
        } catch {
         errorText = "(無錯誤訊息)";
        }
        throw new Error(`伺服器錯誤 (HTTP ${response.status}): ${errorText}`);
        }

        const data = await response.json();

        // 3.處理成功回覆 
        if (data.success) {
            statusDiv.textContent = "分析成功！LLM 結構化數據已取得。";
            statusDiv.className = 'success';
            //將後端傳來的 JSON 數據，格式化後顯示在<pre>標籤中
            resultsPre.textContent = JSON.stringify(data.analysis, null, 2); 
            
            // 處理 TTS 音頻播放
            const audioUrl = data.analysis['音頻檔案連結']; 
            
            // 確保 audioPlayerDiv 被清空
            audioPlayerDiv.innerHTML = ''; 

            if (audioUrl && audioUrl !== '/') {
                const FULL_AUDIO_URL = audioUrl.startsWith('http')
                 ? audioUrl
              : `${BACKEND_URL}/${audioUrl.replace(/^\/+/, '')}`;



                // 創建 audio 元素
                const audio = document.createElement('audio');
                audio.controls = true;
                audio.src = FULL_AUDIO_URL;
                
                // 將 audio 元素加入到 DOM 中 ***
                audioPlayerDiv.appendChild(audio); 
                
                audio.load(); 
                // audio.play(); // 保持靜音，不自動播放

            } else {
                 audioPlayerDiv.textContent = "錯誤：音頻連結遺失或不正確。";
            }

        } else {
            // 處理後端程式碼中的邏輯錯誤 
            statusDiv.textContent = `後端邏輯錯誤：${data.message}`;
            statusDiv.className = 'error';
            resultsPre.textContent = '請檢查 Node.js 終端機日誌。';
        }
    } 
    catch (error) {
        // 4.處理連線或網路錯誤 
        statusDiv.textContent = '連線錯誤！無法連接到 Node.js 伺服器 (請確認 server.js 是否運行中)。';
        statusDiv.className = 'error';
        resultsPre.textContent = error.toString();
        console.error("Fetch Error:", error);
    }
}
