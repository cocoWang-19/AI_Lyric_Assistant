import express from "express";
import cors from "cors"; 
import dotenv from "dotenv"; 
import mysql from "mysql2/promise";

// --- LLM 客戶端使用新的 @google/genai 庫 ---
import { GoogleGenAI } from "@google/genai"; // 注意導入方式修正

// --- TTS 客戶端使用舊的 @google-cloud/text-to-speech ---
import { TextToSpeechClient } from "@google-cloud/text-to-speech";

// 變動區域 1: 導入 GCS 模組 
import { Storage } from "@google-cloud/storage";



// 環境配置加載 ---
dotenv.config();





// 關鍵變量定義
const project = process.env.GCP_PROJECT_ID; 
const location = "us-central1"; 
const MODEL_ID = "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // 新增：讀取 Gemini API Key

// 變動區域 2: 定義 GCS 儲存桶變數 
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME;

// ----------------------------------------------------
// I. 初始化 AI 服務
// ----------------------------------------------------
// 優先從環境變數讀取 JSON 憑證字串 
const serviceAccountJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SA_KEY; 

let credentials = {};
if (serviceAccountJson) {
    try {
        // 解析 JSON 字串為憑證物件
        credentials = JSON.parse(serviceAccountJson);
        console.log('[GCP Credential] Using JSON string from environment variable (Cloud Mode).');
    } catch (e) {
        console.error('【致命錯誤】無法解析 GCP 服務帳號 JSON 字串！', e);
        // 如果解析失敗，credentials 將保持空，讓客戶端嘗試默認認證
    }
} else {
    console.log('[GCP Credential] No JSON string found. Falling back to default authentication (Local .env file or Railway Service Link).');
}

// *** LLM 客戶端：使用新的 GenAI 客户端，通過 API KEY 驗證 ***
const ai = new GoogleGenAI({ 
    apiKey: GEMINI_API_KEY, // 使用 API Key
});


// *** TTS 客戶端：使用服務帳戶密鑰驗證 ***
// 如果 credentials 物件有內容（即雲端模式），則用它來初始化
const ttsClient = new TextToSpeechClient(credentials.private_key ? { credentials } : {});

// GCS 客戶端：同理，如果 credentials 有內容，則用它來初始化
const storage = new Storage(credentials.private_key ? { credentials, projectId: project } : { projectId: project });

const app = express();

console.log('--- 配置檢查 ---');
console.log(`GCP_PROJECT_ID: "${project}"`);
console.log(`LLM Client: GoogleGenAI (API Key Mode)`);
console.log(`TTS Client Status: Using Service Account (GCP)`);
console.log('----------------');

// ----------------------------------------------------
// TTS 輔助邏輯：風格映射與語音合成 (保持不变)
// ----------------------------------------------------
// TTS 邏輯 saveAnalysisHistory 和 synthesizeSpeech 
const ttsStyleMap = {
    '平靜': 'calm', '悲傷': 'sad', '緊張': 'tension', '充滿希望': 'hopeful',
    '敘事': 'narrative', '歡快': 'joyful', '友善': 'friendly', '憤怒': 'angry',
    '莊嚴': 'solemn', '浪漫': 'romantic'
};

function getEnglishStyle(chineseStyle) {
    const style = chineseStyle.trim();
    return ttsStyleMap[style] || 'default';
}
// Railway 服務會自動注入 RAILWAY_ENVIRONMENT_ID
const isCloudEnvironment = !!process.env.RAILWAY_ENVIRONMENT_ID;
// 建立資料庫連接池 
const pool = mysql.createPool({
    host: isCloudEnvironment ? 'ai_lyric_assistant.railway.internal' : process.env.MYSQLHOST || process.env.DB_HOST,
    user: process.env.MYSQLUSER || process.env.DB_USER,
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
    database: process.env.MYSQLDATABASE || process.env.DB_NAME,
    port: process.env.MYSQLPORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,

    ssl: isCloudEnvironment ? { 
        rejectUnauthorized: false 
    } : null
});

    async function saveAnalysisHistory(inputLyrics, analysisResult, genderUsed, audioUrl) {
    try {
        const sql = `
            INSERT INTO analysis_history 
            (input_lyrics, output_analysis, gender_used, audio_file_url) 
            VALUES (?, ?, ?, ?)
        `;
        const analysisJsonString = analysisResult ? JSON.stringify(analysisResult) : null;
        const [rows] = await pool.execute(sql, [inputLyrics, analysisJsonString, genderUsed, audioUrl]);
        console.log(`[MySQL] 成功新增一筆歷史記錄 (ID: ${rows.insertId})`);
        } catch (err) {
        console.error("【嚴重錯誤】MySQL 儲存失敗:", err);
        }
}

async function synthesizeSpeech(text, style, gender) {
    let rate = '100%'; 
    let pitch = '+1st'; 

    // --- 語音風格轉換邏輯 ---
    if (style === 'sad') {
        rate = '85%';    
        pitch = '-0.5st'; 
    } else if (style === 'calm') {
        rate = '95%';    
        pitch = '+0st'; 
    } else if (style === 'tension') {
        rate = '115%';   
        pitch = '+3st';  
    } else if (style === 'hopeful') {
        rate = '105%';   
        pitch = '+2st';  
    } else if (style === 'narrative') {
        rate = '100%';   
        pitch = '+1st'; 
    } else if (style === 'joyful') {
        rate = '125%';   
        pitch = '+4st';  
    } else if (style === 'friendly') {
        rate = '105%';   
        pitch = '+1.5st'; 
    } else if (style === 'angry') {
        rate = '120%';   
        pitch = '-1st'; 
    } else if (style === 'solemn') {
        rate = '80%';    
        pitch = '0st'; 
    } else if (style === 'romantic') {
        rate = '90%';    
        pitch = '+1st'; 
    }
    
    const ssmlText = `
        <speak>
            <prosody rate="${rate}" pitch="${pitch}">
                ${text}
            </prosody>
        </speak>`;

    let voiceName;
    if (gender === 'MALE') {
        voiceName = 'cmn-CN-Wavenet-B'; 
    } else {
        voiceName = 'cmn-CN-Wavenet-A'; 
    }
    
    const request = {
        input: { ssml: ssmlText },
        voice: { languageCode: "cmn-CN", name: voiceName },
        audioConfig: { audioEncoding: "MP3" },
    };

    // TTS Client 使用已配置的 GOOGLE_APPLICATION_CREDENTIALS
    const [response] = await ttsClient.synthesizeSpeech(request); 
  
   // --- 🎯 核心變動：將音頻上傳到 GCS ---
// 如果警告持續，請嘗試在函數頂部或這些變數定義行前面加上禁用註釋
if (!GCS_BUCKET_NAME) {
    throw new Error("GCS_BUCKET_NAME 環境變數未設置。無法儲存音頻。");
}

const bucket = storage.bucket(GCS_BUCKET_NAME);
// 確保檔案名稱唯一
const audioFileName = `audio-${Date.now()}-${Math.random().toString(36).substring(2, 9)}.mp3`;
const file = bucket.file(audioFileName);

// eslint-disable-next-line max-statements
// eslint-disable-next-line complexity
// 上傳音頻數據 (Buffer) 到 GCS
await file.save(response.audioContent, {
    metadata: {
        contentType: 'audio/mp3',
        cacheControl: 'public, max-age=31536000', // 啟用快取
    },
    
});

// 生成 GCS 的公開 URL
const gcsPublicUrl = `https://storage.googleapis.com/${GCS_BUCKET_NAME}/${audioFileName}`;

console.log(`[GCS] 音頻已上傳至 GCS: ${gcsPublicUrl}`);
// --- 核心變動結束 ---

return gcsPublicUrl;

}
// ----------------------------------------------------
// II. 伺服器配置 
// ----------------------------------------------------

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ----------------------------------------------------
// III. 核心分析路由
// ----------------------------------------------------

app.post('/lyrics', async (req, res) => {

    const { lyrics, gender } = req.body;
    const finalLyrics = lyrics || "快樂的時光總是過得特別快。";

    // 調整 Prompt
    const prompt = `你是一位專業的音樂理論專家。你的首要任務是輸出嚴格的 JSON 格式。
    **輸出規則：'情感' 欄位只允許使用中文描述，嚴禁出現任何英文翻譯或括號。**
    JSON 必須包含以下所有欄位：
    1. '情感' 
    2. 'BPM' 
    3. '和弦'
    4. '語音風格'（限以下之一：
    ['平靜', '悲傷', '緊張', '充滿希望', '敘事', '歡快', '友善', '憤怒', '莊嚴','浪漫'])
    請分析以下歌詞："${finalLyrics}"`;

    console.log(`正在分析歌詞: "${String(finalLyrics).substring(0, 15)}..."`);

    try {
        // 确保 API Key 已加載 ***
        if (!GEMINI_API_KEY) {
            console.error("【致命錯誤】GEMINI_API_KEY 未加載。請檢查 .env 文件！");
            return res.status(500).json({ success: false, message: "配置錯誤：Gemini API Key 未定義。" });
        }

        // LLM 呼叫：使用 API Key 模式 ***
        const response = await ai.models.generateContent({
            model: MODEL_ID, // gemini-1.5-flash
            contents: prompt,
            config: {
                temperature: 0.7,
                responseMimeType: "application/json",
            }
        });

        const jsonString = response.text.trim();
        let analysisResult;
        try {
            analysisResult = JSON.parse(jsonString);
        } catch (parseError) {
            console.error("【JSON 解析錯誤】模型返回的不是有效的 JSON:", jsonString);
            throw new Error("模型返回格式錯誤，无法解析 JSON。");
        }
        
        console.log("Gemini 回傳:", analysisResult);

        //***提取中文風格並轉換為 API 要求的英文風格 ***/
        const chineseStyle = analysisResult['語音風格'];
        const englishStyle = getEnglishStyle(chineseStyle);

        analysisResult['英文語音風格(TTS用)'] = englishStyle;

        console.log(`[TTS 轉換] 中文風格: ${chineseStyle} → 英文風格 ${englishStyle}`);

        // *** TTS 呼叫：使用已配置的 GCP 服务帳號 ***
        const audioUrl = await synthesizeSpeech(finalLyrics, englishStyle, gender);
        analysisResult['音頻檔案連結'] = audioUrl;

        // 确保所有參數都不會是 null
        const genderToSave = gender || 'UNKNOWN';
        const finalLyricsToSave = finalLyrics || 'NO LYRICS PROVIDED';
        const finalAudioUrlToSave = audioUrl || null;
        
        await saveAnalysisHistory(
            finalLyricsToSave, 
            analysisResult, 
            genderToSave, 
            finalAudioUrlToSave 
        );

        res.json({ success: true, analysis: analysisResult });

    } catch (error) {
        console.error("LLM/TTS API 呼叫失敗:", error);
        res.status(500).json({ success: false, message: "AI 分析失敗，請檢查 API Key、網路或 Prompt 格式要求。" });
    }
});

// ----------------------------------------------------
// IV. 啟動伺服器
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`伺服器正在運行於 http://localhost:${PORT}`);
});