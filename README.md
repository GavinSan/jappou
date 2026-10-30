# 執譜機 Jap Pou Gei

貼一條 YouTube 連結（或者上載 MP3），佢會：

- 分離人聲、鼓、Bass、結他、琴、其他（Demucs 6-stem）
- 認出首歌有咩樂器
- **執鼓譜**（ADTOF，分得出 kick、snare、hi-hat 開/合、tom 高/中/低、crash/ride），用標準鼓譜呈現，手同腳分兩個聲部
- 執埋結他（五線譜 + TAB）、Bass（五線譜 + TAB）、琴（左右手）、人聲旋律
- 搵拍子、BPM、小節線
- 用 Whisper 聽寫歌詞（廣東話／普通話／English／日本語／한국어），中文自動轉繁體
- 播放時有條線跟住譜行，歌詞逐字變色
- 調速度（唔變音）、總音量、每件樂器音量（M 靜音 / S 獨奏）、「無鼓練習」
- 拍子機（跟首歌真實嘅拍子，唔係死板 BPM）、預備拍、A-B 循環（亦可以喺譜上拖選一段）
- **🎮 模擬器**：鼓 → 擬真鼓組（打邊件就亮邊件，光圈收埋提示下一下）；結他 / Bass → 指板顯示撳邊格 + 和弦指法；琴 → 琴鍵亮燈（橙色右手、藍色左手）+ 和弦音
- **和弦**：自動認和弦（包括 maj7、m7、sus4、slash chord 例如 C/E），顯示喺譜上、模擬器同 PDF；結他 PDF 頂部有齊全首歌嘅和弦指法圖
- **🎯 練習模式**：無鼓 / 無人聲（唱 K）/ 無結他 / 無 Bass / 無琴 / 淨鼓 / 節奏組（鼓 + Bass）/ 淨人聲，揀咗會自動轉去嗰件樂器嘅譜
- **✏️ 改譜**：逐小節改：鼓用格仔（好似鼓機），其他樂器用 piano roll，仲可以改和弦；可以無限還原
- 先上網（LRCLIB）搵有時間軸嘅歌詞，自動對正首歌；搵唔到先用 Whisper 自己聽
- 下載 PDF（A4，每件樂器一份）俾鼓手／樂手睇
- **自動放上 Google Drive**：分析完自動將 PDF、分離咗嘅音軌、歌詞（LRC）同 GP5 檔放入 Google Drive，手機 / iPad 即刻睇到

全部喺你自己部電腦行，唔使上傳去任何伺服器，亦唔使任何 API key。

## 安裝 — Windows（NVIDIA 顯示卡）

1. 解壓呢個資料夾去一個**冇中文、冇空格**嘅位置，例如 `C:\jappou`
2. 雙擊 **`install.bat`**（大約 10–20 分鐘，下載 4–6 GB）
   - 冇 Python 3.11 嘅話會自動用 winget 裝，裝完要**閂咗個視窗再開多次 install.bat**
3. 雙擊 **`run.bat`**，瀏覽器會自動開 <http://localhost:8765>

**由舊版升級**：將新版檔案覆蓋落舊資料夾（`data/` 會保留你嘅歌），再行一次 `install.bat`（已裝嘅嘢會跳過，好快）。

## 安裝 — Mac

1. 解壓去例如 `~/jappou`
2. 雙擊 **`install.command`**
   - 如果 macOS 話「無法打開，因為來自未識別的開發者」：右鍵 → 打開 → 打開；或者喺 Terminal 打 `bash ~/jappou/install.command`
   - 冇 Python 3.11 嘅話：有 Homebrew 會自動裝，冇就會開 python.org 俾你下載
3. 雙擊 **`run.command`**

M 系列晶片（M1–M4）會用 Mac 嘅 GPU 加速分離樂器同執鼓譜，歌詞用 Apple 專用嘅 MLX Whisper，一首 4 分鐘嘅歌大約 5–10 分鐘。Intel Mac 都用得，但係會慢好多。

第一首歌會額外下載 AI 模型（Demucs ~80 MB、Whisper 1.5–3 GB），之後就唔使。

## 用法

| 操作 | 方法 |
|---|---|
| 播放 / 暫停 | `Space` 或 ▶ |
| 前後 5 秒 | `←` `→` |
| 速度 −0.1 / +0.1 | `[` `]`（或者撳 −0.5 −0.1 +0.1 +0.5） |
| 音量 −5 / +5 | `↓` `↑`（或者撳 −10 −5 +5 +10） |
| 模擬器開 / 關 | `S` 或「🎮 模擬器」 |
| 改譜 | 撳一下譜上要改嘅位置，再撳「✏️ 改譜」（或者 `E`）→ 撳格仔加 / 刪 → 儲存 |
| 還原改動 | 「↶ 還原」 |
| 練習模式 | 底部 🎯 選單 |
| 和弦開 / 關 | 「和弦」掣 |
| 拍子機 | `M` |
| 跳去某粒音 | 㩒譜上面嗰粒音 |
| 循環一段 | 喺譜上拖選，或者用 A / B 掣 |
| 揀樂器譜 | 上面「鼓 / 人聲旋律 / 結他 / Bass / 琴」 |
| 改歌詞 | 「改歌詞」→ 可以改字、㩒 ⏱ 將嗰句對正而家位置、或者貼全首歌詞 |
| 小節線錯位 / 速度快咗一倍 | 「⚙ 譜設定」→ 移前/移後一拍、×2 / ÷2、拍號 |
| PDF | 「⤓ PDF」→ 揀樂器 → 直接下載 |
| 上 Google Drive | 「☁ 上 Drive」（或者喺設定開「自動匯出」） |

## Google Drive

1. 裝 [Google Drive for desktop](https://www.google.com/drive/download/) 並登入
2. 喺 app 主頁右上角「⚙ 設定」→ 匯出資料夾揀佢搵到嘅「My Drive / 我的雲端硬碟」（會自動偵測）
3. 之後每首歌分析完就會出現喺 Drive 嘅 `執譜機/歌名/`：
   - `歌名 - 鼓.pdf`、`歌名 - 結他.pdf`…（每件樂器一份）
   - `音軌/鼓.mp3`、`音軌/人聲.mp3`…
   - `歌名 - 歌詞.lrc`、`歌名 - 和弦.txt`（純文字和弦譜）、`歌名.gp5`（可以用 Guitar Pro 等軟件開）
4. 改咗歌詞、譜設定或者歌名之後，會自動更新 Drive 入面嘅檔案

## 準確度（老實講）

- **鼓**：最準。kick / snare / hi-hat 一般幾好；ghost note、花 fill、ride vs crash 有時會錯，當係一份好嘅初稿再自己修。
- **Bass、琴**：唔錯。
- **結他**：有失真、厚混音嘅歌會比較亂，和弦會漏音。TAB 指法係程式估嘅。
- **歌詞**：英文、日文、韓文、普通話幾準；**廣東話**有時會變書面語或者錯字 → 用「改歌詞」或者直接貼正確歌詞（時間會保留）。
- **和弦**：流行曲大部分和弦會認到，複雜 jazz 和弦會簡化（例如 9th → 7th）。認錯可以喺「✏️ 改譜」嘅和弦格改。
- 拍號自動偵測假設成首歌唔轉拍。
- 「重新分析成首歌」會覆蓋你改過嘅譜同和弦。

## 疑難

- **YouTube 下載唔到**：YouTube 成日改，雙擊 `update-youtube.bat` 更新 yt-dlp。都唔得就用「上載 MP3」。
- **好慢**：右上角應該見到你張顯示卡名。如果寫「CPU 模式」，即係 PyTorch 冇用到 GPU → 重新行 `install.bat`。
- **顯示卡記憶體唔夠（out of memory）**：Whisper 會按 VRAM 自動揀模型（≥11 GB 用 large-v3，≥6 GB 用 turbo，否則 small）。
- **樂譜顯示唔到**：樂譜引擎已經包埋喺 `frontend/vendor/alphatab/`。撳 Ctrl+F5 重新載入；仲係唔得就撳 F12 → Console，將紅色錯誤影低。播放、混音、拍子機唔受影響。
- **PDF / 上 Drive 失敗**：重新行一次安裝程式（會裝 PDF 引擎）。Windows 冇 Chromium 嘅話會自動用 Edge。
- 分析結果全部喺 `data/jobs/`，刪咗就冇。

## 技術

`backend/`：FastAPI + yt-dlp → Demucs `htdemucs_6s` → Beat This!（拍子 + downbeat）→ ADTOF-pytorch（鼓）→ Basic Pitch（其他樂器）→ OpenAI Whisper（歌詞）→ PyGuitarPro 寫 GP5 → Playwright（headless 瀏覽器）用 `print.html` 出 PDF。
`frontend/`：純 HTML/JS，alphaTab 畫譜（external media 模式，用 sync point 對準真實錄音嘅每一拍），Web Audio 混音。

YouTube 下載只限個人練習用途，請尊重版權同 YouTube 條款。
