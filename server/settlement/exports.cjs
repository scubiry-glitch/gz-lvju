'use strict';

const fs = require('node:fs');
const { check,time } = require('./external.cjs');
const fields = ['line_key','record_type','biz_type','payment_mode','execution_scope','order_ref','event_kind','amount_minor','currency','verification_status','occurred_at','received_at','obligation_direction','debtor_party_id','creditor_party_id','note','recovery_id','recovery_kind','principal_minor','initial_recovered_minor'];
const labels = ['明细标识','记录类型','业务','支付渠道','执行范围','订单号','事实类型','金额(最小单位)','币种','核验状态','实际发生时间','接收时间','债务方向','债务主体','债权主体','说明','追偿编号','追偿类型','原追偿本金(最小单位)','追偿创建前已回收(最小单位)'];
function safe(value) {
  if (value == null) return '';
  const s = String(value);
  // Apply the same injection policy to every text column, including references.
  return /^[\s]*[=+\-@]|^[\t\r\n]/.test(s) ? "'" + s : s;
}
function csvRow(values) { return values.map(v => '"' + safe(v).replace(/"/g,'""') + '"').join(','); }
function metadata(s) {
  const scope=s.snapshot.scope||{};
  return [ ['账单号',s.statement_no],['版本',s.version],['主体',s.party_id],['币种',s.currency],
    ['业务范围',(scope.biz_types||[]).join(',')],['支付范围',(scope.payment_modes||[]).join(',')],['合同筛选',scope.contract_ref||'全部已纳入范围的合同'],
    ['账期开始(UTC)',time(s.period_start)],['账期结束(UTC，半开)',time(s.period_end)],['统计截止(UTC)',time(s.as_of)],
    ['核对状态',s.recon_status],['覆盖状态',s.coverage_status],['出具状态',s.publication_status],
    ...Object.entries(s.snapshot.summary).map(([k,v])=>[k,v]) ];
}
async function buildExport(statement, format, config = {}) {
  check(['csv','xlsx','pdf'].includes(format),'导出格式无效',422);
  const lines=statement.snapshot.lines,meta=metadata(statement);
  check(lines.length<=100000,'账单超过单文件导出上限，请缩小账期',422);
  const filename=statement.statement_no+'-v'+statement.version+'.'+format;
  if(format==='csv'){
    const body='\ufeff'+[...meta.map(csvRow),'',csvRow(labels),...lines.map(l=>csvRow(fields.map(f=>l[f])))].join('\r\n');
    return {buffer:Buffer.from(body,'utf8'),filename,contentType:'text/csv; charset=utf-8'};
  }
  if(format==='xlsx'){
    const ExcelJS=require('exceljs'),wb=new ExcelJS.Workbook();wb.creator='新居住结算中心';wb.created=new Date(time(statement.created_at).replace(' ','T')+'Z');
    const overview=wb.addWorksheet('账单汇总');overview.columns=[{width:38},{width:60}];
    for(const row of meta)overview.addRow(row.map(safe));
    const detail=wb.addWorksheet('明细');detail.columns=labels.map((header,i)=>({header,key:fields[i],width:i===15?45:22}));
    for(const l of lines)detail.addRow(Object.fromEntries(fields.map(f=>[f,safe(l[f])])));
    detail.views=[{state:'frozen',ySplit:1}];detail.autoFilter={from:'A1',to:{row:1,column:fields.length}};
    return {buffer:Buffer.from(await wb.xlsx.writeBuffer()),filename,contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  }
  const PDFDocument=require('pdfkit');
  const font=config.SETTLEMENT_PDF_FONT||process.env.SETTLEMENT_PDF_FONT||'/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc';
  check(fs.existsSync(font),'缺少中文PDF字体，请配置 SETTLEMENT_PDF_FONT',503,'pdf_font_missing');
  const doc=new PDFDocument({size:'A4',margin:40,bufferPages:true,info:{Title:'新居住收款方对账单 '+statement.statement_no}}),chunks=[];
  const completed=new Promise((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  try{
    if(/\.ttc$/i.test(font))doc.font(font,config.SETTLEMENT_PDF_FONT_FAMILY||process.env.SETTLEMENT_PDF_FONT_FAMILY||'NotoSansCJKsc-Regular');else doc.font(font);
    doc.fontSize(16).text('新居住收款方对账单');doc.moveDown().fontSize(9);
    for(const [label,value]of meta)doc.text(label+'：'+String(value??''));
    doc.moveDown().fontSize(12).text('逐笔明细（金额为最小货币单位）').fontSize(8);
    for(const [index,l]of lines.entries()){
      if(doc.y>690)doc.addPage();
      doc.moveDown(.5).text((index+1)+'. '+fields.filter(f=>l[f]!=null&&l[f]!=='').map(f=>labels[fields.indexOf(f)]+'：'+String(l[f])).join('  |  '),{lineGap:2});
    }
    const range=doc.bufferedPageRange();
    for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);doc.fontSize(8).text('第 '+(i+1)+' / '+range.count+' 页 · '+statement.statement_no,40,805,{lineBreak:false});}
    doc.end();return {buffer:await completed,filename,contentType:'application/pdf'};
  }catch(e){doc.destroy();throw e;}
}
module.exports={buildExport,safe,csvRow,fields,labels};
