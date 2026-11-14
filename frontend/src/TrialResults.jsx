import { useEffect, useState } from 'react';

function Judgement({ value }) {
  const status = value.toUpperCase();
  const tone = status === 'PASS' ? 'pass' : status === 'FAIL' || status === 'NG' ? 'fail' : 'unjudged';
  return <span className={`csv-judgement ${tone}`}>{value || '-'}</span>;
}

function getRowJudgements(row) {
  return row.measurements
    .flatMap((measurement) => [
      measurement.minJudgement,
      measurement.maxJudgement,
      measurement.judgement,
    ])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toUpperCase());
}

function getRowJudgement(row) {
  const judgements = getRowJudgements(row);
  if (judgements.some((value) => value === 'FAIL' || value === 'NG')) return 'FAIL';
  if (judgements.length && judgements.every((value) => value === 'PASS')) return 'PASS';
  return 'UNJUDGED';
}

function hasNgJudgement(row) {
  return getRowJudgements(row).includes('NG');
}

export default function TrialResults({ recordId, files, pendingFiles, csrfToken, request, setAuthenticated, setLoginError, fileActionPending, onDeleteFile }) {
  const [selectedKey, setSelectedKey] = useState('');
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState('');
  const [sectionIndex, setSectionIndex] = useState(0);
  const [search, setSearch] = useState('');
  const [judgement, setJudgement] = useState('');
  const [columnWidths, setColumnWidths] = useState({});
  const [resizeState, setResizeState] = useState(null);
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
  const searchTerm = search.trim().toLocaleLowerCase();
  const rows = section?.rows.filter((row) => (
    (!searchTerm
      || row.no.toLocaleLowerCase().includes(searchTerm))
    && (!judgement || (judgement === 'NG'
      ? hasNgJudgement(row)
      : getRowJudgement(row) === judgement))
  )) || [];
  const summary = section?.rows.reduce((counts, row) => {
    counts[getRowJudgement(row)] += 1;
    return counts;
  }, { PASS: 0, FAIL: 0, UNJUDGED: 0 });
  const analog = section?.number === 1;
  const baseColumns = analog ? 5 : 4;
  const temperatureWidth = analog ? 4 : 2;
  const tableKey = analog ? 'analog' : 'digital';
  const activeColumnWidths = columnWidths[tableKey];
  const tableWidth = activeColumnWidths?.reduce((total, width) => total + width, 0);

  function startColumnResize(event, columnIndex) {
    if (event.button !== 0) return;
    event.preventDefault();
    const table = event.currentTarget.closest('table');
    if (!table) return;
    const startWidths = [...table.querySelectorAll('col')]
      .map((column) => column.getBoundingClientRect().width);
    if (!startWidths[columnIndex]) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizeState({
      tableKey,
      columnIndex,
      startX: event.clientX,
      startWidths,
      pointerId: event.pointerId,
    });
  }

  function resizeColumn(event) {
    if (
      !resizeState
      || (resizeState.pointerId !== undefined && event.pointerId !== resizeState.pointerId)
    ) return;
    const width = Math.max(
      48,
      Math.round(resizeState.startWidths[resizeState.columnIndex] + event.clientX - resizeState.startX),
    );
    setColumnWidths((current) => {
      const widths = [...(current[resizeState.tableKey] || resizeState.startWidths)];
      widths[resizeState.columnIndex] = width;
      return { ...current, [resizeState.tableKey]: widths };
    });
  }

  function finishColumnResize(event) {
    if (
      !resizeState
      || (resizeState.pointerId !== undefined && event.pointerId !== resizeState.pointerId)
    ) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizeState(null);
  }

  function resizeHandle(columnIndex) {
    return (
      <span
        className="csv-column-resize-handle"
        aria-hidden="true"
        title="ドラッグして列幅を変更"
        onPointerDown={(event) => startColumnResize(event, columnIndex)}
        onPointerMove={resizeColumn}
        onPointerUp={finishColumnResize}
        onPointerCancel={finishColumnResize}
      />
    );
  }

  function columnStyle(columnIndex) {
    return activeColumnWidths ? { width: activeColumnWidths[columnIndex] } : undefined;
  }

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
                onClick={() => setSectionIndex(index)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? data.sections.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + data.sections.length) % data.sections.length;
                  setSectionIndex(next);
                  event.currentTarget.parentElement.children[next].focus();
                }}
              >{item.title}</button>
            ))}
          </div>
          <div role="tabpanel" id={`csv-panel-${section.number}`} aria-labelledby={`csv-tab-${section.number}`}>
            <div className="csv-summary" aria-label="試験項目の判定集計">
              <strong>{section.rows.length}項目</strong>
              <span className="csv-judgement pass">PASS {summary.PASS}</span>
              <span className="csv-judgement fail">FAIL {summary.FAIL}</span>
              <span className="csv-judgement unjudged">未判定 {summary.UNJUDGED}</span>
            </div>
            <div className="csv-filters">
              <label className="field"><span>試験項目を検索</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
              <label className="field"><span>判定</span><select value={judgement} onChange={(event) => setJudgement(event.target.value)}><option value="">すべて</option><option value="NG">NG</option><option value="UNJUDGED">未判定</option><option value="PASS">PASS</option></select></label>
            </div>
            <div className="csv-table-wrap" tabIndex={0} aria-label={`${section.title}の測定結果`}>
              <table
                className={`trial-results-table${analog ? ' analog' : ''}`}
                aria-label={section.title}
                style={tableWidth ? { width: tableWidth, minWidth: tableWidth } : undefined}
              >
                <colgroup>
                  <col className="csv-no-column" style={columnStyle(0)} />
                  <col className="csv-name-column" style={columnStyle(1)} />
                  {Array.from({ length: baseColumns - 2 }, (_, index) => (
                    <col
                      key={`base-${index}`}
                      className={index === baseColumns - 3 ? 'csv-unit-column' : 'csv-value-column'}
                      style={columnStyle(index + 2)}
                    />
                  ))}
                  {Array.from({ length: temperatureWidth * 3 }, (_, index) => (
                    <col
                      key={`measurement-${index}`}
                      className={index % 2 ? 'csv-judgement-column' : 'csv-value-column'}
                      style={columnStyle(baseColumns + index)}
                    />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th rowSpan={2} scope="col">No.{resizeHandle(0)}</th>
                    <th rowSpan={2} scope="col">試験名称{resizeHandle(1)}</th>
                    {analog ? (
                      <>
                        <th rowSpan={2} scope="col">下限値{resizeHandle(2)}</th>
                        <th rowSpan={2} scope="col">上限値{resizeHandle(3)}</th>
                      </>
                    ) : <th rowSpan={2} scope="col">規定値{resizeHandle(2)}</th>}
                    <th rowSpan={2} scope="col">単位{resizeHandle(baseColumns - 1)}</th>
                    {section.temperatures.map((temperature, index) => <th key={index} colSpan={temperatureWidth} scope="colgroup" className="csv-temperature">{temperature.label} {temperature.value}</th>)}
                  </tr>
                  <tr>{section.temperatures.map((_, index) => analog
                    ? ['MIN', '判定', 'MAX', '判定'].map((label, column) => (
                      <th key={`${index}-${column}`} scope="col">
                        {label}{resizeHandle(baseColumns + index * temperatureWidth + column)}
                      </th>
                    ))
                    : ['測定値', '判定'].map((label, column) => (
                      <th key={`${index}-${column}`} scope="col">
                        {label}{resizeHandle(baseColumns + index * temperatureWidth + column)}
                      </th>
                    )))}</tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${row.no}-${index}`} className={getRowJudgement(row) === 'FAIL' ? 'csv-failed-row' : ''}>
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