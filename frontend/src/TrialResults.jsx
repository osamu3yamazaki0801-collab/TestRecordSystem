import { useEffect, useState } from 'react';

const PAGE_SIZE = 50;

function Judgement({ value }) {
  const status = value.toUpperCase();
  return <span className={`csv-judgement ${status === 'PASS' ? 'pass' : status === 'FAIL' ? 'fail' : 'unjudged'}`}>{value || '-'}</span>;
}

export default function TrialResults({ recordId, files, pendingFiles, csrfToken, request, setAuthenticated, setLoginError, fileActionPending, onDeleteFile }) {
  const [selectedKey, setSelectedKey] = useState('');
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState('');
  const [sectionIndex, setSectionIndex] = useState(0);
  const [search, setSearch] = useState('');
  const [judgement, setJudgement] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const sources = [
    ...pendingFiles.filter((file) => /\.csv$/i.test(file.name)).map((file, index) => ({ key: `pending:${index}`, file, pending: true, name: file.name })),
    ...files.filter((file) => /\.csv$/i.test(file.fileName)).map((file) => ({ key: `saved:${file.id}`, file, pending: false, name: file.fileName })),
  ];
  const source = sources.find((item) => item.key === selectedKey) || sources[0];
  const sourceKey = source?.key;
  const sourceFile = source?.file;
  const pending = source?.pending;
  const data = parsed && parsed.key === sourceKey ? parsed.data : null;

  useEffect(() => {
    if (pendingFiles.length) setSelectedKey('pending:0');
  }, [pendingFiles]);

  useEffect(() => {
    setParsed(null);
    setError('');
    if (!sourceFile) return undefined;
    if (pending && sourceFile.size > 100 * 1024 * 1024) {
      setError('試験結果CSVは100 MB以下にしてください。');
      return undefined;
    }
    const controller = new AbortController();
    const options = { signal: controller.signal };
    let url = `/api/records/${recordId}/files/${sourceFile.id}/results`;
    if (pending) {
      const form = new FormData();
      form.append('resultFile', sourceFile);
      options.method = 'POST';
      options.body = form;
      url = `/api/records/${recordId}/results-preview`;
    }
    request(url, csrfToken, options).then((result) => {
      if (controller.signal.aborted) return;
      setParsed({ key: sourceKey, data: result });
      setSectionIndex(0);
      setPageNumber(1);
    }).catch((failure) => {
      if (controller.signal.aborted) return;
      setError(failure.message);
      if (failure.status === 401) {
        setAuthenticated(false);
        setLoginError(failure.message);
      }
    });
    return () => controller.abort();
  }, [recordId, sourceKey, sourceFile, pending, csrfToken, request, setAuthenticated, setLoginError]);

  if (!source) return null;

  const section = data?.sections[sectionIndex];
  const rows = section?.rows.filter((row) => (
    (!search || `${row.no} ${row.name}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    && (!judgement || row.judgement === judgement)
  )) || [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(pageNumber, pageCount);
  const visibleRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const analog = section?.number === 1;
  const baseColumns = analog ? 5 : 4;
  const temperatureWidth = analog ? 4 : 2;

  return (
    <section className="trial-results-panel" aria-labelledby="trial-results-title">
      <div className="csv-heading">
        <h2 id="trial-results-title">試験結果（CSV）</h2>
        {pending && <span className="status-text warning">未保存</span>}
      </div>
      <div className="csv-file-controls">
        <label className="field csv-file-select">
          <span>試験結果ファイル</span>
          <select value={sourceKey} onChange={(event) => setSelectedKey(event.target.value)}>
            {sources.map((item) => <option key={item.key} value={item.key}>{item.name}{item.pending ? '（未保存）' : ''}</option>)}
          </select>
        </label>
        {files.length > 0 && (
          <button type="button" className="delete-button csv-file-delete" disabled={fileActionPending} onClick={onDeleteFile}>
            {fileActionPending ? '削除中...' : '削除する'}
          </button>
        )}
      </div>
      {!data && <p className={`status-text${error ? ' error' : ''}`} aria-live="polite">{error || 'CSVを読み込み中...'}</p>}
      {data && section && (
        <>
          <dl className="csv-metadata">
            {['品名', '仕様書番号', '試験番号'].map((label) => <div key={label}><dt>{label}</dt><dd>{data.metadata[label]}</dd></div>)}
          </dl>
          <div className="csv-section-tabs" role="tablist" aria-label="試験結果の種類">
            {data.sections.map((item, index) => (
              <button
                key={item.number}
                type="button"
                role="tab"
                aria-selected={sectionIndex === index}
                id={`csv-tab-${item.number}`}
                aria-controls={`csv-panel-${item.number}`}
                tabIndex={sectionIndex === index ? 0 : -1}
                onClick={() => { setSectionIndex(index); setPageNumber(1); }}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? data.sections.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + data.sections.length) % data.sections.length;
                  setSectionIndex(next);
                  setPageNumber(1);
                  event.currentTarget.parentElement.children[next].focus();
                }}
              >{item.title}</button>
            ))}
          </div>
          <div role="tabpanel" id={`csv-panel-${section.number}`} aria-labelledby={`csv-tab-${section.number}`}>
            <div className="csv-summary" aria-label="試験項目の判定集計">
              <strong>{section.rows.length}項目</strong>
              <span className="csv-judgement pass">PASS {section.summary.PASS}</span>
              <span className="csv-judgement fail">FAIL {section.summary.FAIL}</span>
              <span className="csv-judgement unjudged">未判定 {section.summary.UNJUDGED}</span>
            </div>
            <div className="csv-filters">
              <label className="field"><span>試験項目を検索</span><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPageNumber(1); }} /></label>
              <label className="field"><span>判定</span><select value={judgement} onChange={(event) => { setJudgement(event.target.value); setPageNumber(1); }}><option value="">すべて</option><option value="FAIL">FAIL</option><option value="UNJUDGED">未判定</option><option value="PASS">PASS</option></select></label>
            </div>
            <div className="csv-table-wrap" tabIndex={0} aria-label={`${section.title}の測定結果`}>
              <table className={`trial-results-table${analog ? ' analog' : ''}`} aria-label={section.title}>
                <colgroup>
                  <col className="csv-no-column" /><col className="csv-name-column" />
                  {Array.from({ length: baseColumns - 2 }, (_, index) => <col key={`base-${index}`} className="csv-value-column" />)}
                  {Array.from({ length: temperatureWidth * 3 }, (_, index) => <col key={`measurement-${index}`} className={index % 2 ? 'csv-judgement-column' : 'csv-value-column'} />)}
                </colgroup>
                <thead>
                  <tr>
                    <th rowSpan={2} scope="col">No.</th><th rowSpan={2} scope="col">試験名称</th>
                    {analog ? <><th rowSpan={2} scope="col">下限値</th><th rowSpan={2} scope="col">上限値</th></> : <th rowSpan={2} scope="col">規定値</th>}
                    <th rowSpan={2} scope="col">単位</th>
                    {section.temperatures.map((temperature, index) => <th key={index} colSpan={temperatureWidth} scope="colgroup" className="csv-temperature">{temperature.label} {temperature.value}</th>)}
                  </tr>
                  <tr>{section.temperatures.map((_, index) => analog
                    ? ['MIN', '判定', 'MAX', '判定'].map((label, column) => <th key={`${index}-${column}`} scope="col">{label}</th>)
                    : ['測定値', '判定'].map((label, column) => <th key={`${index}-${column}`} scope="col">{label}</th>))}</tr>
                </thead>
                <tbody>
                  {visibleRows.map((row, index) => (
                    <tr key={`${row.no}-${index}`} className={row.judgement === 'FAIL' ? 'csv-failed-row' : ''}>
                      <th scope="row">{row.no}</th><td className="csv-test-name">{row.name}</td>
                      {analog ? <><td>{row.lowerLimit || '-'}</td><td>{row.upperLimit || '-'}</td></> : <td>{row.specifiedValue || '-'}</td>}
                      <td>{row.unit || '-'}</td>
                      {row.measurements.map((measurement, measurementIndex) => analog ? (
                        <CsvAnalogCells key={measurementIndex} measurement={measurement} />
                      ) : <CsvDigitalCells key={measurementIndex} measurement={measurement} />)}
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={baseColumns + temperatureWidth * 3} className="empty-row">該当する試験項目はありません。</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="csv-pagination">
              <span>{rows.length ? `${(currentPage - 1) * PAGE_SIZE + 1}～${Math.min(currentPage * PAGE_SIZE, rows.length)}` : '0'} / {rows.length}項目</span>
              <button type="button" className="secondary-button" disabled={currentPage === 1} onClick={() => setPageNumber(currentPage - 1)}>前へ</button>
              <span>{currentPage} / {pageCount}</span>
              <button type="button" className="secondary-button" disabled={currentPage === pageCount} onClick={() => setPageNumber(currentPage + 1)}>次へ</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function CsvAnalogCells({ measurement }) {
  return <><td>{measurement.min || '-'}</td><td><Judgement value={measurement.minJudgement} /></td><td>{measurement.max || '-'}</td><td><Judgement value={measurement.maxJudgement} /></td></>;
}

function CsvDigitalCells({ measurement }) {
  return <><td>{measurement.value || '-'}</td><td><Judgement value={measurement.judgement} /></td></>;
}