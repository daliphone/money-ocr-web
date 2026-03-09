import React, { useState, useRef, useMemo } from 'react';
import { 
  Upload, FileText, Image as ImageIcon, CheckCircle, AlertCircle, 
  Download, Loader2, Plus, Receipt, Trash2, Camera, FolderTree, 
  FileQuestion, CloudUpload, Edit3, ZoomIn, ZoomOut, Maximize 
} from 'lucide-react';

// ==========================================
// 1. 核心 Prompt 定義 (The Brain)
// ==========================================
const SYSTEM_PROMPT = `
請扮演一位擁有 20 年經驗的台灣資深會計師，你具備極強的視覺辨識能力與邏輯推演能力。
你的任務是解析使用者上傳的各種單據圖片（包含：電子發票證明聯、傳統三聯式發票、收銀機發票、出貨單、簽收單等），並精準萃取出指定的會計欄位。

⚠️ 嚴格執行準則 (Defensive Rules)：
1. 日期格式化：遇到民國年請自動加上 1911 轉換為西元年。最終輸出格式強制為 YYYY-MM-DD。
2. 統一編號防呆：台灣統編必定為 8 碼數字。傳統發票賣方統編常藏在右下角的「統一發票專用章」內。
3. 發票號碼格式：標準為 2位大寫英文 + 8位數字。若無標準號碼請填入單據號碼。
4. 名稱萃取：請從印章或單據頂部精準抓取「賣方名稱」與「買方名稱 (公司抬頭)」(例如：阿仔企業社)。
5. 金額拆解：區分「未稅金額(pre_tax_amount)」、「營業稅額(tax_amount)」與「含稅總計(total_amount)」。
6. 通訊業特化 (備註與IMEI)：
   - 單據總備註(remarks)：請抓取發票/單據上的「訂單編號、出貨單號、交易單號」等重要補充資訊。
   - 明細備註(item_remark)：在解析商品明細時，請特別注意是否有附屬的「IMEI碼、機號、序號」或特殊型號備註，並將其填入 item_remark。

📥 輸出格式要求 (Output Format)：
你只能輸出純淨的 JSON 格式，不要包含 Markdown 標記，嚴格遵守以下結構：
{
  "document_type": "string",
  "invoice_number": "string",
  "date": "string",
  "seller_name": "string",
  "seller_tax_id": "string",
  "buyer_name": "string",
  "buyer_tax_id": "string",
  "pre_tax_amount": 0,
  "tax_amount": 0,
  "total_amount": 0,
  "remarks": "string",
  "items": [
    {"product_name": "string", "quantity": 0, "unit_price": 0, "subtotal": 0, "item_remark": "string"}
  ]
}
`;

// 您的專屬 GAS 網址 (請確保此網址正確)
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwanlx4zU2P0gyynvEcplWYMrrj2X8uyUoeqaXrobgOuiPEFJHUef8qlZX8Z0ORLQtZ/exec"; 

export default function App() {
  // ==========================================
  // 2. 狀態管理 (State)
  // ==========================================
  const [documents, setDocuments] = useState([]);
  const [activeDocId, setActiveDocId] = useState(null);
  const [zoomScale, setZoomScale] = useState(1); // 預覽圖片縮放比例
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null); 

  // 計算頂部統計數據
  const stats = useMemo(() => {
    let totalDocs = documents.length;
    let totalAmount = 0;
    let pendingCount = 0;
    documents.forEach(doc => {
      if (doc.status === 'completed' && doc.ocrData) {
        totalAmount += Number(doc.ocrData.total_amount) || 0;
      }
      if (doc.status === 'processing' || doc.status === 'pending' || doc.status === 'reviewing' || doc.status === 'saving') {
        pendingCount++;
      }
    });
    return { totalDocs, totalAmount, pendingCount };
  }, [documents]);

  const activeDoc = documents.find(d => d.id === activeDocId);

  // 計算自動分類歸檔路徑
  const archivePath = useMemo(() => {
    if (!activeDoc || !activeDoc.ocrData) return null;
    const data = activeDoc.ocrData;
    const yearMonth = data.date ? data.date.substring(0, 7).replace('-', '年') + '月' : '未分類日期';
    const docType = data.document_type || '其他單據';
    const seller = data.seller_name || '未知廠商';
    const invNum = data.invoice_number || '無單號';
    const extension = 'jpg';
    return {
      folder: `/馬尼通訊_會計憑證/${yearMonth}/${docType}/`,
      filename: `${seller}_${invNum}_${data.date || 'nodate'}.${extension}`
    };
  }, [activeDoc]);

  // ==========================================
  // 3. 核心處理邏輯
  // ==========================================
  const generateId = () => Math.random().toString(36).substr(2, 9);

  const handleFiles = async (files) => {
    if (!files || files.length === 0) return;
    const newDocs = Array.from(files).filter(f => f.type.startsWith('image/')).map(file => ({
      id: generateId(),
      file,
      name: file.name,
      previewUrl: URL.createObjectURL(file),
      status: 'pending', 
      ocrData: null,
      error: null,
      base64: null,
      mimeType: null
    }));
    if (newDocs.length === 0) return;
    setDocuments(prev => [...prev, ...newDocs]);
    if (!activeDocId) {
      setActiveDocId(newDocs[0].id);
      setZoomScale(1);
    }
    newDocs.forEach(doc => processDocument(doc.id, doc.file));
  };

  const handleFileChange = (e) => handleFiles(e.target.files);
  const handleDrop = (e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); };
  const handleDragOver = (e) => e.preventDefault();
  const triggerFileInput = () => fileInputRef.current.click();
  const triggerCameraInput = () => cameraInputRef.current.click();

  const compressImage = (file, maxWidth = 2000) => { // 稍微提高解析度以利放大觀看
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new Image();
        img.src = event.target.result;
        img.onload = () => {
          let width = img.width;
          let height = img.height;
          if (width > maxWidth || height > maxWidth) {
            if (width > height) {
              height = Math.round((height * maxWidth) / width);
              width = maxWidth;
            } else {
              width = Math.round((width * maxWidth) / height);
              height = maxWidth;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.9);
          const base64Data = compressedDataUrl.replace(/^data:image\/jpeg;base64,/, '');
          resolve({ base64: base64Data, mimeType: 'image/jpeg' });
        };
        img.onerror = error => reject(error);
      };
      reader.onerror = error => reject(error);
    });
  };

  const fetchWithRetry = async (url, options, maxRetries = 3) => {
    const delays = [1000, 3000, 5000];
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
      } catch (err) {
        if (i === maxRetries - 1) throw err;
        await new Promise(resolve => setTimeout(resolve, delays[i]));
      }
    }
  };

  const processDocument = async (id, file) => {
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'processing', error: null } : d));
    try {
      const { base64: base64Data, mimeType } = await compressImage(file);
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, base64: base64Data, mimeType: mimeType } : d));
      const payload = { action: 'parse', base64: base64Data, mimeType: mimeType, prompt: SYSTEM_PROMPT };
      const result = await fetchWithRetry(GAS_WEB_APP_URL, { method: 'POST', body: JSON.stringify(payload) });
      if (result.success && result.data) {
        setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'reviewing', ocrData: result.data } : d));
      } else {
        throw new Error(result.error || "GAS 伺服器回傳錯誤");
      }
    } catch (err) {
      console.error("Parse Error:", err);
      let errMsg = err.message || "解析失敗，請重試。";
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'error', error: errMsg } : d));
    }
  };

  const confirmAndSave = async (id) => {
    const docToSave = documents.find(d => d.id === id);
    if (!docToSave) return;
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'saving', error: null } : d));
    try {
      const payload = { action: 'save', ocrData: docToSave.ocrData, base64: docToSave.base64 };
      const result = await fetchWithRetry(GAS_WEB_APP_URL, { method: 'POST', body: JSON.stringify(payload) });
      if (result.success) {
        setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'completed' } : d));
      } else {
        throw new Error(result.error || "寫入試算表失敗");
      }
    } catch (err) {
      console.error("Save Error:", err);
      let errMsg = err.message || "存檔失敗，請重試。";
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'error', error: errMsg } : d));
    }
  };

  const removeDocument = (e, id) => {
    e.stopPropagation();
    setDocuments(prev => prev.filter(d => d.id !== id));
    if (activeDocId === id) setActiveDocId(null);
  };

  const updateActiveDocData = (field, value) => {
    setDocuments(prev => prev.map(doc => {
      if (doc.id === activeDocId && doc.ocrData) {
        const newData = { ...doc.ocrData, [field]: value };
        if (field === 'pre_tax_amount' || field === 'tax_amount') {
          const preTax = parseFloat(newData.pre_tax_amount) || 0;
          const tax = parseFloat(newData.tax_amount) || 0;
          newData.total_amount = preTax + tax;
        }
        return { ...doc, ocrData: newData };
      }
      return doc;
    }));
  };

  const updateActiveDocItem = (index, field, value) => {
    setDocuments(prev => prev.map(doc => {
      if (doc.id === activeDocId && doc.ocrData) {
        const newItems = [...doc.ocrData.items];
        newItems[index] = { ...newItems[index], [field]: value };
        if (field === 'quantity' || field === 'unit_price') {
          const qty = parseFloat(newItems[index].quantity) || 0;
          const price = parseFloat(newItems[index].unit_price) || 0;
          newItems[index].subtotal = qty * price;
        }
        return { ...doc, ocrData: { ...doc.ocrData, items: newItems } };
      }
      return doc;
    }));
  };

  const exportAllToCSV = () => {
    const completedDocs = documents.filter(d => d.status === 'completed' && d.ocrData);
    if (completedDocs.length === 0) return alert("沒有可匯出的已完成單據！");
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
    csvContent += "單據類型,日期,發票號碼,賣方名稱,賣方統編,公司抬頭(買方),買方統編,未稅金額,營業稅額,含稅總計,單據備註(訂單號),預計歸檔檔名,品名,明細備註(IMEI),數量,單價,小計\n";
    completedDocs.forEach(doc => {
      const data = doc.ocrData;
      const invNum = data.invoice_number || '無單號';
      const archiveFilename = `${data.seller_name}_${invNum}_${data.date}.jpg`;
      if (data.items && data.items.length > 0) {
        data.items.forEach(item => {
          csvContent += [data.document_type, data.date, invNum, `"${data.seller_name}"`, data.seller_tax_id, `"${data.buyer_name}"`, data.buyer_tax_id, data.pre_tax_amount, data.tax_amount, data.total_amount, `"${data.remarks}"`, archiveFilename, `"${item.product_name}"`, `"${item.item_remark}"`, item.quantity, item.unit_price, item.subtotal].join(",") + "\n";
        });
      }
    });
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", `馬尼通訊_批次匯總表_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getInputClass = (val, isCore) => {
    const base = "bg-[#F8FAFC] text-right font-bold text-[#1E293B] rounded-md px-3 py-1.5 w-full outline-none transition-all shadow-sm text-base tracking-wide ";
    if (isCore && (!val || val === 'null' || val === 'N/A' || val === '')) return base + "text-[#9B2C2C] border border-[#D9A0A0] bg-[#FFF2F2] focus:ring-2 focus:ring-[#D9A0A0]";
    return base + "border border-[#E2E8F0] focus:border-[#7692B4] focus:bg-white focus:ring-2 focus:ring-[#7692B4]/20";
  };

  // ==========================================
  // 4. UI 渲染 (均分三欄版)
  // ==========================================
  return (
    <div className="flex flex-col h-screen bg-[#F4F7F9] font-sans text-[#4C566A]">
      {/* Header */}
      <header className="h-16 bg-white border-b border-[#E5E9F0] flex items-center justify-between px-6 shrink-0 z-10 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-[#7692B4] text-white p-2 rounded-lg shadow-sm"><Receipt size={20} /></div>
          <div>
            <h1 className="text-lg font-bold text-[#1E293B] tracking-wider">馬尼通訊 發票辨識系統</h1>
            <p className="text-[10px] text-[#64748B] font-mono tracking-widest uppercase font-semibold">Smart Accounting OCR Solution</p>
          </div>
        </div>
        <div className="flex items-center gap-8">
          <div className="flex flex-col items-end"><span className="text-xs text-[#64748B] font-semibold">本批張數</span><span className="text-2xl font-black text-[#2C5282]">{stats.totalDocs}</span></div>
          <div className="flex flex-col items-end"><span className="text-xs text-[#64748B] font-semibold">合計金額</span><span className="text-2xl font-black text-[#2C5282]">NT$ {stats.totalAmount.toLocaleString()}</span></div>
          <div className="flex flex-col items-end"><span className="text-xs text-[#64748B] font-semibold">待處理/核對</span><span className="text-2xl font-black text-[#9B2C2C]">{stats.pendingCount}</span></div>
        </div>
      </header>

      {/* Main Layout - 均分三欄 */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Column 1: 檔案列表 (flex-1) */}
        <div className="flex-1 bg-white border-r border-[#E5E9F0] flex flex-col shrink-0 z-10 shadow-sm min-w-0">
          <div className="m-4 grid grid-cols-2 gap-3">
            <div className="p-4 border border-[#E2E8F0] rounded-xl flex flex-col items-center justify-center text-center cursor-pointer hover:bg-[#F8FAFC] hover:border-[#7692B4] transition-all group bg-white shadow-sm" onClick={triggerFileInput} onDrop={handleDrop} onDragOver={handleDragOver}>
              <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*" multiple />
              <Plus size={24} className="text-[#8F9CAE] group-hover:text-[#7692B4] mb-2" /><p className="text-[#64748B] group-hover:text-[#7692B4] font-bold text-sm">檔案上傳</p>
            </div>
            <div className="p-4 border border-[#E2E8F0] rounded-xl flex flex-col items-center justify-center text-center cursor-pointer hover:bg-[#F8FAFC] hover:border-[#8EBAA3] transition-all group bg-white shadow-sm" onClick={triggerCameraInput}>
              <input type="file" ref={cameraInputRef} onChange={handleFileChange} className="hidden" accept="image/*" capture="environment" multiple />
              <Camera size={24} className="text-[#8F9CAE] group-hover:text-[#8EBAA3] mb-2" /><p className="text-[#64748B] group-hover:text-[#8EBAA3] font-bold text-sm">相機拍攝</p>
            </div>
          </div>
          <div className="px-4 pb-2 border-b border-[#F4F7F9]"><h3 className="text-xs font-bold text-[#64748B] uppercase tracking-wider">上傳佇列 ({documents.length})</h3></div>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 custom-scrollbar">
            {documents.map((doc) => (
              <div key={doc.id} onClick={() => { setActiveDocId(doc.id); setZoomScale(1); }} className={`relative p-3 rounded-xl border cursor-pointer transition-all group ${activeDocId === doc.id ? 'bg-[#F0F4F8] border-[#7692B4] shadow-sm' : 'bg-white border-[#E2E8F0] hover:bg-[#F8FAFC]'}`}>
                <div className="flex items-start gap-3">
                  <FileText size={16} className={`mt-0.5 ${activeDocId === doc.id ? 'text-[#7692B4]' : 'text-[#94A3B8]'}`} />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate font-bold ${activeDocId === doc.id ? 'text-[#1E293B]' : 'text-[#475569]'}`}>{doc.name}</p>
                    <div className="flex items-center mt-1">
                      {doc.status === 'completed' && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-[#8EBAA3]/10 text-[#2F855A] border border-[#8EBAA3]/30">歸檔完成</span>}
                      {doc.status === 'reviewing' && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-[#F6E05E]/20 text-[#975A16] border border-[#F6E05E]/50">待核對</span>}
                      {doc.status === 'processing' && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-[#E2E8F0] text-[#475569] border border-[#CBD5E1]"><Loader2 size={10} className="animate-spin" /> 解析中</span>}
                      {doc.status === 'error' && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-[#D08C8C]/10 text-[#9B2C2C] border border-[#D08C8C]/30">失敗</span>}
                    </div>
                  </div>
                  <button onClick={(e) => removeDocument(e, doc.id)} className="text-[#CBD5E1] hover:text-[#D08C8C] opacity-0 group-hover:opacity-100"><Trash2 size={16} /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="p-4 border-t border-[#E5E9F0] bg-white">
            <button onClick={exportAllToCSV} disabled={stats.totalDocs === 0 || stats.totalDocs > (documents.filter(d => d.status === 'completed').length)} className="w-full bg-[#7692B4] hover:bg-[#2C5282] disabled:bg-[#E2E8F0] disabled:text-[#94A3B8] text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-colors shadow-sm text-sm"><Download size={18} /> 下載 Excel 匯總表</button>
            <div className="mt-4 text-center"><p className="text-[11px] text-[#94A3B8] font-bold tracking-widest uppercase">©馬尼通訊 財會專用</p></div>
          </div>
        </div>

        {/* Column 2: 原始單據預覽 (flex-1) */}
        <div className="flex-1 bg-[#F4F7F9] flex flex-col relative border-r border-[#E5E9F0] min-w-0">
          <div className="h-12 flex items-center px-4 shrink-0 absolute top-0 left-0 right-0 z-10 bg-[#F4F7F9]/80 backdrop-blur-sm">
             <ImageIcon size={16} className="text-[#64748B] mr-2" /><span className="text-sm font-bold text-[#64748B]">原始單據預覽</span>
          </div>
          
          <div className="flex-1 overflow-auto custom-scrollbar mt-12 relative bg-gray-200/50">
            {activeDoc ? (
              <div className="flex items-center justify-center min-h-full min-w-full p-8">
                <img 
                  src={activeDoc.previewUrl} 
                  alt="Preview" 
                  style={{ transform: `scale(${zoomScale})`, transformOrigin: 'center center' }}
                  className="max-w-full max-h-full object-contain rounded-lg shadow-2xl transition-transform duration-200 bg-white" 
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-[#94A3B8]"><Camera size={48} className="mb-4 opacity-30" /><p className="font-bold">請先上傳單據</p></div>
            )}
          </div>

          {/* Zoom Controls */}
          {activeDoc && (
            <div className="absolute bottom-6 right-6 flex items-center gap-2 bg-white/90 backdrop-blur p-2 rounded-2xl shadow-xl border border-white z-20">
              <button onClick={() => setZoomScale(s => Math.max(0.5, s - 0.25))} className="p-2 hover:bg-gray-100 rounded-xl text-gray-600 transition-colors"><ZoomOut size={20} /></button>
              <span className="text-xs font-black text-gray-500 w-12 text-center">{Math.round(zoomScale * 100)}%</span>
              <button onClick={() => setZoomScale(s => Math.min(3, s + 0.25))} className="p-2 hover:bg-gray-100 rounded-xl text-gray-600 transition-colors"><ZoomIn size={20} /></button>
              <div className="w-px h-4 bg-gray-200 mx-1"></div>
              <button onClick={() => setZoomScale(1)} className="p-2 hover:bg-gray-100 rounded-xl text-[#7692B4] transition-colors" title="重設大小"><Maximize size={20} /></button>
            </div>
          )}
        </div>

        {/* Column 3: AI 解析結果 (flex-1) */}
        <div className="flex-1 bg-white flex flex-col shrink-0 overflow-y-auto custom-scrollbar shadow-sm relative min-w-0">
          {!activeDoc ? (
            <div className="flex-1 flex flex-col items-center justify-center text-[#94A3B8] p-12 text-center"><FolderTree size={64} className="mb-6 opacity-10" /><p className="font-black text-lg">等待處理中</p><p className="text-sm mt-2 font-bold">上傳照片後 Marshall 會立刻為您辨識</p></div>
          ) : activeDoc.status === 'processing' || activeDoc.status === 'pending' ? (
            <div className="flex-1 flex flex-col items-center justify-center text-[#7692B4] p-8 text-center"><Loader2 size={48} className="animate-spin mb-6 opacity-80 text-[#2C5282]" /><p className="text-xl font-black text-[#1E293B]">AI 智慧解析中...</p><p className="text-sm text-[#64748B] font-bold mt-2 leading-relaxed">正在萃取核心欄位與 IMEI 碼</p></div>
          ) : activeDoc.status === 'saving' ? (
            <div className="flex-1 flex flex-col items-center justify-center text-[#2F855A] p-8 text-center"><CloudUpload size={48} className="animate-bounce mb-6 opacity-80" /><p className="text-xl font-black text-[#1E293B]">正式入帳中...</p><p className="text-sm text-[#64748B] font-bold mt-2">正在同步至 Google Sheets 並存檔圖片</p></div>
          ) : activeDoc.status === 'error' ? (
            <div className="flex-1 flex flex-col items-center justify-center text-[#9B2C2C] p-8 text-center"><AlertCircle size={48} className="mb-4 opacity-80" /><p className="text-xl font-black">處理失敗</p><p className="text-sm font-bold mt-2">{activeDoc.error}</p><button onClick={() => activeDoc.ocrData ? confirmAndSave(activeDoc.id) : processDocument(activeDoc.id, activeDoc.file)} className="mt-6 px-6 py-3 bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-[#F1F5F9] text-[#1E293B] font-bold rounded-xl shadow-sm transition-all">重新嘗試</button></div>
          ) : (
            <div className="p-6 space-y-6">
              <div className="flex items-center justify-between mb-4 border-b border-[#F4F7F9] pb-4"><h2 className="text-xl font-black text-[#1E293B] flex items-center gap-2">🤖 AI 辨識結果</h2><span className="text-xs px-2.5 py-1 rounded bg-[#F0F4F8] text-[#2C5282] font-black border border-[#7692B4]/30">{activeDoc.ocrData?.document_type || '單據'}</span></div>
              
              <div className="mb-6">{activeDoc.status === 'completed' ? (
                <div className="bg-[#F0FDF4] p-4 rounded-xl border border-[#8EBAA3]/60 shadow-sm flex items-start gap-3"><CheckCircle className="text-[#2F855A] mt-0.5" size={18} /><div><p className="text-[13px] text-[#2F855A] font-black">✅ 已成功同步至雲端系統</p><p className="text-[11px] text-[#2F855A] font-bold mt-3 uppercase tracking-tighter">歸檔位置：{archivePath?.folder}</p></div></div>
              ) : (
                <div className="bg-[#FFFBEB] p-4 rounded-xl border border-[#F6E05E]/60 shadow-sm flex items-start gap-3"><Edit3 className="text-[#975A16] mt-0.5" size={18} /><div><p className="text-[13px] text-[#975A16] font-black">⚠️ 請人工核對並修正</p><p className="text-[11px] text-[#B7791F] font-bold mt-2">修改完成後請點擊下方入帳按鈕</p></div></div>
              )}</div>

              <div className="space-y-4">
                <div className="flex items-center text-[#64748B] text-xs font-black uppercase tracking-widest"><span className="mr-2 h-px flex-1 bg-[#E2E8F0]"></span> 表頭資訊 <span className="ml-2 h-px flex-1 bg-[#E2E8F0]"></span></div>
                <div className={`space-y-3 bg-white p-5 rounded-2xl border shadow-sm ${activeDoc.status === 'completed' ? 'border-[#E2E8F0] opacity-70' : 'border-[#7692B4]/30'}`}>
                  {['invoice_number', 'date', 'seller_name', 'seller_tax_id', 'buyer_name', 'buyer_tax_id'].map((field) => (
                    <div key={field} className="flex justify-between items-center gap-4">
                      <label className="text-xs text-[#475569] font-black w-24 shrink-0 uppercase">{field.replace(/_/g, ' ')}</label>
                      <input value={activeDoc.ocrData?.[field] || ''} onChange={(e) => updateActiveDocData(field, e.target.value)} readOnly={activeDoc.status === 'completed'} className={getInputClass(activeDoc.ocrData?.[field], ['invoice_number', 'date', 'seller_tax_id', 'buyer_name'].includes(field))} />
                    </div>
                  ))}
                  <div className="flex justify-between items-start pt-2 gap-4"><label className="text-xs text-[#475569] font-black w-24 shrink-0 mt-2 uppercase">REMARKS</label><textarea value={activeDoc.ocrData?.remarks || ''} onChange={(e) => updateActiveDocData('remarks', e.target.value)} readOnly={activeDoc.status === 'completed'} className="bg-[#F8FAFC] text-[#1E293B] font-bold rounded-md px-3 py-2 w-full outline-none border border-[#E2E8F0] focus:border-[#7692B4] h-16 text-sm resize-none" /></div>
                </div>

                <div className="flex items-center text-[#64748B] text-xs font-black uppercase tracking-widest mt-8"><span className="mr-2 h-px flex-1 bg-[#E2E8F0]"></span> 金額結算 <span className="ml-2 h-px flex-1 bg-[#E2E8F0]"></span></div>
                <div className={`space-y-3 bg-white p-5 rounded-2xl border shadow-sm ${activeDoc.status === 'completed' ? 'border-[#E2E8F0] opacity-70' : 'border-[#7692B4]/30'}`}>
                  <div className="flex justify-between items-center"><label className="text-xs font-black text-gray-400">含稅總計</label><div className="flex items-center justify-end"><span className="text-[#2C5282] mr-2 text-sm font-black">NT$</span><input type="number" value={activeDoc.ocrData?.total_amount || ''} readOnly={activeDoc.status === 'completed'} onChange={(e) => updateActiveDocData('total_amount', e.target.value)} className="bg-transparent text-right text-[#2C5282] text-2xl font-black w-40 outline-none border-b-2 border-transparent focus:border-[#7692B4]" /></div></div>
                </div>

                <div className="flex items-center text-[#64748B] text-xs font-black uppercase tracking-widest mt-8"><span className="mr-2 h-px flex-1 bg-[#E2E8F0]"></span> 商品明細 <span className="ml-2 h-px flex-1 bg-[#E2E8F0]"></span></div>
                <div className="bg-white rounded-2xl border border-[#E2E8F0] overflow-hidden shadow-sm">
                  <table className="w-full text-left text-xs"><thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]"><tr><th className="p-3 font-black text-gray-500">品名 / IMEI</th><th className="p-3 font-black text-gray-500 text-right w-16">數量</th><th className="p-3 font-black text-gray-500 text-right">小計</th></tr></thead><tbody className="divide-y divide-[#F4F7F9]">
                    {activeDoc.ocrData?.items?.map((item, idx) => (
                      <tr key={idx} className="hover:bg-gray-50 transition-colors">
                        <td className="p-3"><textarea value={item.product_name || ''} readOnly={activeDoc.status === 'completed'} onChange={(e) => updateActiveDocItem(idx, 'product_name', e.target.value)} className="w-full bg-transparent text-[#1E293B] font-bold outline-none resize-none h-10 border border-transparent focus:bg-white p-1" /><input value={item.item_remark || ''} readOnly={activeDoc.status === 'completed'} onChange={(e) => updateActiveDocItem(idx, 'item_remark', e.target.value)} className="w-full bg-gray-50 text-[#2C5282] text-[10px] font-bold rounded px-2 py-1 mt-1 outline-none" placeholder="IMEI碼" /></td>
                        <td className="p-3 align-top"><input type="number" readOnly={activeDoc.status === 'completed'} value={item.quantity || ''} onChange={(e) => updateActiveDocItem(idx, 'quantity', e.target.value)} className="w-full bg-transparent text-right font-black outline-none" /></td>
                        <td className="p-3 align-top text-right font-black text-gray-800">{(item.subtotal || 0).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody></table>
                </div>
              </div>
              
              {activeDoc.status === 'reviewing' && (
                <div className="sticky bottom-0 bg-white pt-4 pb-6 border-t border-[#E2E8F0] mt-8 z-30"><button onClick={() => confirmAndSave(activeDoc.id)} className="w-full bg-[#2F855A] hover:bg-[#276749] text-white font-black py-4 rounded-2xl flex items-center justify-center gap-3 transition-all shadow-xl hover:-translate-y-1 text-lg"><CloudUpload size={24} /> 檔案核對無誤，寫入雲端入帳</button></div>
              )}
            </div>
          )}
        </div>
      </div>
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { width: 5px; height: 5px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 10px; }
        input[type="number"]::-webkit-inner-spin-button, input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
      `}} />
    </div>
  );
}