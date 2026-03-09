import React, { useState, useRef, useMemo, useEffect } from 'react';
import { 
  Upload, FileText, Image as ImageIcon, CheckCircle, AlertCircle, 
  Download, Loader2, Plus, Receipt, Trash2, Camera, FolderTree, 
  FileQuestion, CloudUpload, Edit3, ZoomIn, ZoomOut, Maximize, List, Search, ChevronRight
} from 'lucide-react';

// ==========================================
// 1. 核心 Prompt 定義
// ==========================================
const SYSTEM_PROMPT = `
請扮演一位擁有 20 年經驗的台灣資深會計師，你具備極強的視覺辨識能力與邏輯推演能力。
你的任務是解析使用者上傳的各種單據圖片（包含：電子發票證明聯、傳統三聯式發票、收銀機發票、出貨單、簽收單等），並精準萃取出指定的會計欄位。

⚠️ 嚴格執行準則 (Defensive Rules)：
1. 日期格式化：遇到民國年請自動加上 1911 轉換為西元年。最終輸出格式強制為 YYYY-MM-DD。
2. 統一編號防呆：台灣統編必定為 8 碼數字。
3. 發票號碼格式：標準為 2位大寫英文 + 8位數字。若無標準號碼請填入單據號碼。
4. 金額拆解：區分「未稅金額」、「營業稅額」與「含稅總計」。
5. 通訊業特化：特別注意 IMEI 碼、機號或序號。

📥 輸出格式要求 (JSON)：
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

const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwanlx4zU2P0gyynvEcplWYMrrj2X8uyUoeqaXrobgOuiPEFJHUef8qlZX8Z0ORLQtZ/exec"; 

export default function App() {
  // ==========================================
  // 2. 狀態管理
  // ==========================================
  const [documents, setDocuments] = useState([]);
  const [activeDocId, setActiveDocId] = useState(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [mobileView, setMobileView] = useState('list');
  const [isDragging, setIsDragging] = useState(false); // 追蹤是否正在拖曳檔案
  
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null); 

  useEffect(() => {
    if (activeDocId && window.innerWidth < 768 && mobileView === 'list') {
      setMobileView('preview');
    }
  }, [activeDocId]);

  const stats = useMemo(() => {
    let totalDocs = documents.length;
    let totalAmount = 0;
    let pendingCount = 0;
    documents.forEach(doc => {
      if (doc.status === 'completed' && doc.ocrData) {
        totalAmount += Number(doc.ocrData.total_amount) || 0;
      }
      if (doc.status === 'processing' || doc.status === 'reviewing' || doc.status === 'saving') {
        pendingCount++;
      }
    });
    return { totalDocs, totalAmount, pendingCount };
  }, [documents]);

  const activeDoc = documents.find(d => d.id === activeDocId);

  const archivePath = useMemo(() => {
    if (!activeDoc || !activeDoc.ocrData) return null;
    const data = activeDoc.ocrData;
    const yearMonth = data.date ? data.date.substring(0, 7).replace('-', '年') + '月' : '未分類日期';
    const docType = data.document_type || '其他單據';
    return {
      folder: `/馬尼通訊_會計憑證/${yearMonth}/${docType}/`,
      filename: `${data.seller_name || '未知'}_${data.invoice_number || '無單號'}_${data.date || '無日期'}.jpg`
    };
  }, [activeDoc]);

  // ==========================================
  // 3. 核心功能函數
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
      base64: null,
      mimeType: null
    }));
    if (newDocs.length === 0) return;
    setDocuments(prev => [...prev, ...newDocs]);
    if (!activeDocId) setActiveDocId(newDocs[0].id);
    newDocs.forEach(doc => processDocument(doc.id, doc.file));
  };

  // 處理拖放事件
  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const compressImage = (file, maxWidth = 1800) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (e) => {
        const img = new Image();
        img.src = e.target.result;
        img.onload = () => {
          let w = img.width, h = img.height;
          if (w > maxWidth) { h = Math.round((h * maxWidth) / w); w = maxWidth; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
          resolve({ base64, mimeType: 'image/jpeg' });
        };
      };
    });
  };

  const processDocument = async (id, file) => {
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'processing' } : d));
    try {
      const { base64, mimeType } = await compressImage(file);
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, base64, mimeType } : d));
      const payload = { action: 'parse', base64, mimeType, prompt: SYSTEM_PROMPT };
      const response = await fetch(GAS_WEB_APP_URL, { method: 'POST', body: JSON.stringify(payload) });
      const result = await response.json();
      if (result.success) {
        setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'reviewing', ocrData: result.data } : d));
      } else { throw new Error(result.error); }
    } catch (err) {
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'error', error: '解析失敗' } : d));
    }
  };

  const confirmAndSave = async (id) => {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'saving' } : d));
    try {
      const payload = { action: 'save', ocrData: doc.ocrData, base64: doc.base64 };
      const res = await fetch(GAS_WEB_APP_URL, { method: 'POST', body: JSON.stringify(payload) });
      const result = await res.json();
      if (result.success) {
        setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'completed' } : d));
      } else { throw new Error(result.error); }
    } catch (err) {
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, status: 'error', error: '存檔失敗' } : d));
    }
  };

  const updateActiveDocData = (field, value) => {
    setDocuments(prev => prev.map(doc => {
      if (doc.id === activeDocId && doc.ocrData) {
        const newData = { ...doc.ocrData, [field]: value };
        if (field === 'pre_tax_amount' || field === 'tax_amount') {
          newData.total_amount = (parseFloat(newData.pre_tax_amount) || 0) + (parseFloat(newData.tax_amount) || 0);
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
          newItems[index].subtotal = (parseFloat(newItems[index].quantity) || 0) * (parseFloat(newItems[index].unit_price) || 0);
        }
        return { ...doc, ocrData: { ...doc.ocrData, items: newItems } };
      }
      return doc;
    }));
  };

  const exportAllToCSV = () => {
    const completedDocs = documents.filter(d => d.status === 'completed' && d.ocrData);
    if (completedDocs.length === 0) return;
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
    csvContent += "單據類型,日期,發票號碼,賣方名稱,賣方統編,公司抬頭,買方統編,總計金額,備註,檔名,品名,IMEI,數量,單價,小計\n";
    completedDocs.forEach(doc => {
      const data = doc.ocrData;
      const baseInfo = [data.document_type, data.date, data.invoice_number, `"${data.seller_name}"`, data.seller_tax_id, `"${data.buyer_name}"`, data.buyer_tax_id, data.total_amount, `"${data.remarks}"`, `"${data.seller_name}_${data.invoice_number}.jpg"`].join(",");
      data.items.forEach(item => {
        csvContent += baseInfo + `, "${item.product_name}", "${item.item_remark}", ${item.quantity}, ${item.unit_price}, ${item.subtotal}\n`;
      });
    });
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", `馬尼通訊_批次匯總表_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  const getInputClass = (val, isCore) => {
    const base = "bg-[#F8FAFC] text-right font-bold text-[#1E293B] rounded-lg px-3 py-2 w-full outline-none transition-all shadow-sm ";
    if (isCore && (!val || val === 'null' || val === '')) return base + "border-2 border-red-200 bg-red-50 focus:border-red-400";
    return base + "border border-[#E2E8F0] focus:border-[#7692B4] focus:ring-2 focus:ring-[#7692B4]/10";
  };

  // ==========================================
  // 4. UI 渲染
  // ==========================================
  return (
    <div className="flex flex-col h-screen bg-[#F8FAFC] font-sans text-[#4C566A] overflow-hidden">
      
      {/* Header */}
      <header className="bg-white border-b border-[#E5E9F0] px-4 md:px-6 py-3 flex items-center justify-between shrink-0 z-20 shadow-sm">
        <div className="flex items-center gap-2 md:gap-3">
          <div className="bg-[#7692B4] text-white p-1.5 md:p-2 rounded-lg shadow-sm"><Receipt size={18} /></div>
          <div>
            <h1 className="text-sm md:text-lg font-bold text-[#1E293B] tracking-tight whitespace-nowrap">馬尼通訊 發票辨識系統</h1>
            <p className="hidden md:block text-[10px] text-[#64748B] font-mono tracking-widest uppercase font-semibold">Accounting Smart Solutions</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4 md:gap-8">
          <div className="flex flex-col items-end leading-none">
            <span className="text-[10px] text-[#64748B] font-bold mb-1">張數</span>
            <span className="text-lg md:text-2xl font-black text-[#2C5282]">{stats.totalDocs}</span>
          </div>
          <div className="hidden sm:flex flex-col items-end leading-none border-l pl-4 border-gray-100">
            <span className="text-[10px] text-[#64748B] font-bold mb-1">本批金額</span>
            <span className="text-lg md:text-2xl font-black text-[#2C5282]">NT$ {stats.totalAmount.toLocaleString()}</span>
          </div>
          <div className="flex flex-col items-end leading-none border-l pl-4 border-gray-100">
            <span className="text-[10px] text-red-500 font-bold mb-1">待核對</span>
            <span className="text-lg md:text-2xl font-black text-[#9B2C2C]">{stats.pendingCount}</span>
          </div>
        </div>
      </header>

      <main className="flex flex-1 overflow-hidden relative">
        
        {/* Column 1: 上傳佇列 (支援拖放) */}
        <section className={`flex-1 bg-white border-r border-[#E5E9F0] flex flex-col min-w-0 transition-all duration-300 ${mobileView !== 'list' ? 'hidden md:flex' : 'flex'}`}>
          <div className="p-4 grid grid-cols-2 gap-3 shrink-0">
            {/* 檔案上傳按鈕 (支援拖放) */}
            <button 
              onClick={() => fileInputRef.current.click()} 
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              className={`p-4 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center transition-all active:scale-95 ${
                isDragging 
                  ? 'border-[#7692B4] bg-[#F0F4F8] scale-[1.02]' 
                  : 'border-gray-200 bg-white hover:bg-slate-50 hover:border-[#7692B4]'
              }`}
            >
              <input type="file" ref={fileInputRef} onChange={(e) => handleFiles(e.target.files)} className="hidden" accept="image/*" multiple />
              <Plus size={24} className={`mb-1 ${isDragging ? 'text-[#7692B4]' : 'text-[#8F9CAE]'}`} />
              <span className="text-xs font-bold text-slate-600">{isDragging ? '放開上傳' : '檔案上傳'}</span>
            </button>

            <button onClick={() => cameraInputRef.current.click()} className="p-4 border-2 border-dashed border-gray-200 rounded-2xl flex flex-col items-center justify-center bg-white hover:bg-slate-50 hover:border-[#8EBAA3] transition-all active:scale-95">
              <input type="file" ref={cameraInputRef} onChange={(e) => handleFiles(e.target.files)} className="hidden" accept="image/*" capture="environment" multiple />
              <Camera size={24} className="text-[#8F9CAE] mb-1" /><span className="text-xs font-bold text-slate-600">相機拍攝</span>
            </button>
          </div>
          
          <div className="px-4 pb-2 border-b border-gray-50 flex justify-between items-center"><h3 className="text-[11px] font-black text-[#64748B] uppercase tracking-widest">已上傳項目</h3></div>
          
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 custom-scrollbar">
            {documents.map((doc) => (
              <div key={doc.id} onClick={() => setActiveDocId(doc.id)} className={`p-3 rounded-xl border-2 transition-all cursor-pointer relative ${activeDocId === doc.id ? 'bg-[#F0F4F8] border-[#7692B4] shadow-md' : 'bg-white border-transparent hover:border-slate-100 shadow-sm'}`}>
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${activeDocId === doc.id ? 'bg-white text-[#7692B4]' : 'bg-slate-50 text-slate-400'}`}><FileText size={18} /></div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate font-bold ${activeDocId === doc.id ? 'text-[#1E293B]' : 'text-[#475569]'}`}>{doc.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {doc.status === 'completed' && <span className="text-[10px] font-black text-green-600">● 已歸檔</span>}
                      {doc.status === 'reviewing' && <span className="text-[10px] font-black text-orange-500">● 待核對</span>}
                      {doc.status === 'processing' && <span className="text-[10px] font-black text-blue-500 italic">解析中...</span>}
                      {doc.status === 'error' && <span className="text-[10px] font-black text-red-500">失敗</span>}
                    </div>
                  </div>
                  <ChevronRight size={16} className="md:hidden text-slate-300" />
                  <button onClick={(e) => { e.stopPropagation(); setDocuments(d => d.filter(x => x.id !== doc.id)); if(activeDocId === doc.id) setActiveDocId(null); }} className="p-1 text-slate-300 hover:text-red-500 ml-2"><Trash2 size={16} /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="p-4 border-t bg-slate-50/50">
            <button onClick={exportAllToCSV} className="w-full bg-[#7692B4] text-white font-bold py-3 rounded-xl shadow-sm text-sm active:scale-95 transition-all">下載批次 Excel</button>
            <p className="mt-4 text-center text-[10px] text-[#94A3B8] font-bold tracking-widest uppercase">©馬尼通訊 財會專用</p>
          </div>
        </section>

        {/* Column 2: 原始單據預覽 */}
        <section className={`flex-1 bg-slate-200 flex flex-col relative min-w-0 transition-all duration-300 ${mobileView !== 'preview' ? 'hidden md:flex' : 'flex'}`}>
          <div className="flex-1 overflow-auto relative bg-gray-300/40 select-none">
            {activeDoc ? (
              <div className="flex items-center justify-center min-h-full min-w-full p-4 md:p-8">
                <img src={activeDoc.previewUrl} alt="Preview" style={{ transform: `scale(${zoomScale})`, transformOrigin: 'center center' }} className="max-w-full h-auto rounded shadow-2xl bg-white transition-transform duration-200" />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-slate-400 opacity-30"><Camera size={64} /><p className="font-bold mt-4">請先從列表選擇單據</p></div>
            )}
          </div>
          {activeDoc && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-white/90 backdrop-blur p-2 rounded-2xl shadow-xl border border-white z-20">
              <button onClick={() => setZoomScale(s => Math.max(0.5, s - 0.25))} className="p-2 hover:bg-gray-100 rounded-xl text-gray-600"><ZoomOut size={20} /></button>
              <span className="text-xs font-black text-gray-500 min-w-[40px] text-center">{Math.round(zoomScale * 100)}%</span>
              <button onClick={() => setZoomScale(s => Math.min(4, s + 0.25))} className="p-2 hover:bg-gray-100 rounded-xl text-gray-600"><ZoomIn size={20} /></button>
              <div className="w-px h-5 bg-gray-200 mx-1"></div>
              <button onClick={() => setZoomScale(1)} className="p-2 hover:bg-gray-100 rounded-xl text-[#7692B4]"><Maximize size={20} /></button>
            </div>
          )}
        </section>

        {/* Column 3: 資料核對 */}
        <section className={`flex-1 bg-white flex flex-col min-w-0 transition-all duration-300 ${mobileView !== 'edit' ? 'hidden md:flex' : 'flex'}`}>
          {!activeDoc ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-300 p-12 text-center opacity-40"><FolderTree size={64} /><p className="font-black mt-4">選擇單據進行核對</p></div>
          ) : activeDoc.status === 'processing' ? (
            <div className="flex-1 flex flex-col items-center justify-center text-[#7692B4] p-8 text-center"><Loader2 size={56} className="animate-spin mb-6 opacity-80" /><p className="text-xl font-black text-[#1E293B]">AI 解析中...</p></div>
          ) : (
            <div className="p-5 md:p-6 space-y-6 overflow-y-auto custom-scrollbar pb-32">
              <div className="flex items-center justify-between border-b border-gray-100 pb-4 shrink-0">
                <h2 className="text-xl font-black text-[#1E293B] flex items-center gap-2">🤖 解析結果</h2>
                <span className="px-2 py-1 rounded bg-blue-50 text-blue-700 font-black text-[10px] uppercase border border-blue-100">{activeDoc.ocrData?.document_type || '單據'}</span>
              </div>
              
              <div className="space-y-6">
                {activeDoc.status === 'completed' ? (
                  <div className="bg-green-50 p-4 rounded-xl border border-green-200 flex items-start gap-3"><CheckCircle className="text-green-600" size={18} /><div><p className="text-sm text-green-800 font-black">已成功寫入雲端</p><p className="text-[10px] text-green-700 font-bold mt-1 break-all uppercase leading-tight">{archivePath?.folder}</p></div></div>
                ) : (
                  <div className="bg-orange-50 p-4 rounded-xl border border-orange-200 flex items-start gap-3"><Edit3 className="text-orange-600" size={18} /><div><p className="text-sm text-orange-800 font-black">待人工核對</p><p className="text-[10px] text-orange-700 font-bold mt-1 leading-tight">核對完成後請點擊下方按鈕</p></div></div>
                )}

                <div className="space-y-4">
                  <p className="text-[10px] font-black text-[#7692B4] uppercase tracking-widest flex items-center gap-2"><span className="h-px flex-1 bg-[#E2E8F0]"></span> 表頭核心資訊 <span className="h-px flex-1 bg-[#E2E8F0]"></span></p>
                  {['invoice_number', 'date', 'seller_name', 'seller_tax_id', 'buyer_name', 'buyer_tax_id'].map((field) => (
                    <div key={field} className="space-y-1">
                      <label className="text-[10px] font-black text-slate-500 uppercase ml-1">{field.replace(/_/g, ' ')}</label>
                      <input value={activeDoc.ocrData?.[field] || ''} onChange={(e) => updateActiveDocData(field, e.target.value)} readOnly={activeDoc.status === 'completed'} className={getInputClass(activeDoc.ocrData?.[field], ['invoice_number', 'date', 'seller_tax_id', 'buyer_name'].includes(field))} />
                    </div>
                  ))}
                </div>

                <div className="space-y-4 pt-4">
                  <p className="text-[10px] font-black text-[#7692B4] uppercase tracking-widest flex items-center gap-2"><span className="h-px flex-1 bg-[#E2E8F0]"></span> 金額與明細 <span className="h-px flex-1 bg-[#E2E8F0]"></span></p>
                  <div className="bg-[#1E293B] p-5 rounded-2xl shadow-xl shadow-slate-900/10 mb-4">
                    <div className="flex justify-between items-center"><label className="text-xs font-black text-slate-400">TOTAL (NT$)</label><input type="number" value={activeDoc.ocrData?.total_amount || ''} readOnly={activeDoc.status === 'completed'} onChange={(e) => updateActiveDocData('total_amount', e.target.value)} className="bg-transparent text-right text-white text-3xl font-black w-full outline-none tracking-tighter" /></div>
                  </div>
                  
                  <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    <table className="w-full text-left text-[11px]">
                      <thead className="bg-slate-50 border-b"><tr><th className="p-2 font-black text-gray-500 uppercase">ITEM/IMEI</th><th className="p-2 text-right font-black text-gray-500 uppercase">SUBTOTAL</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                        {activeDoc.ocrData?.items?.map((item, idx) => (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className="p-2">
                              <textarea value={item.product_name || ''} readOnly={activeDoc.status === 'completed'} onChange={(e) => updateActiveDocItem(idx, 'product_name', e.target.value)} className="w-full bg-transparent text-[#1E293B] font-bold outline-none resize-none h-8 p-0.5" />
                              <input value={item.item_remark || ''} readOnly={activeDoc.status === 'completed'} onChange={(e) => updateActiveDocItem(idx, 'item_remark', e.target.value)} className="w-full bg-blue-50 text-[#2C5282] text-[9px] font-black rounded px-1.5 py-0.5 mt-1 outline-none" placeholder="IMEI碼" />
                            </td>
                            <td className="p-2 align-top text-right font-black text-slate-700">{(item.subtotal || 0).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {activeDoc.status === 'reviewing' && (
                <div className="fixed md:absolute bottom-20 md:bottom-0 left-0 right-0 p-4 md:p-6 bg-white/95 backdrop-blur border-t border-slate-100 z-30">
                  <button onClick={() => confirmAndSave(activeDoc.id)} className="w-full bg-[#2F855A] hover:bg-[#276749] text-white font-black py-4 rounded-2xl flex items-center justify-center gap-3 shadow-xl transition-all active:scale-[0.98] text-lg">
                    {activeDoc.status === 'saving' ? <Loader2 className="animate-spin" /> : <CloudUpload size={22} />}
                    確認無誤，寫入雲端入帳
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {/* Mobile Nav */}
      <footer className="md:hidden bg-white border-t border-slate-100 h-16 shrink-0 flex items-center justify-around z-40 shadow-[0_-4px_10px_rgba(0,0,0,0.03)]">
        <button onClick={() => setMobileView('list')} className={`flex flex-col items-center gap-1 flex-1 ${mobileView === 'list' ? 'text-[#7692B4]' : 'text-slate-300'}`}>
          <List size={20} strokeWidth={mobileView === 'list' ? 3 : 2} /><span className="text-[9px] font-black uppercase">佇列</span>
        </button>
        <button onClick={() => setMobileView('preview')} className={`flex flex-col items-center gap-1 flex-1 ${mobileView === 'preview' ? 'text-[#7692B4]' : 'text-slate-300'}`}>
          <ImageIcon size={20} strokeWidth={mobileView === 'preview' ? 3 : 2} /><span className="text-[9px] font-black uppercase">單據</span>
        </button>
        <button onClick={() => setMobileView('edit')} className={`flex flex-col items-center gap-1 flex-1 ${mobileView === 'edit' ? 'text-[#7692B4]' : 'text-slate-300'}`}>
          <Search size={20} strokeWidth={mobileView === 'edit' ? 3 : 2} /><span className="text-[9px] font-black uppercase">核對</span>
        </button>
      </footer>

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 10px; }
        input[type="number"]::-webkit-inner-spin-button, input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        @media (max-width: 768px) { .pb-32 { padding-bottom: 140px; } }
      `}} />
    </div>
  );
}
