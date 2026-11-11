export function createDesignExporter({ getContext, beforeOpen, toast }) {
  const $ = id => document.getElementById(id);
  const dialog = $("designExportDialog");
  let snapshot = [], selectedIds = [], busy = false;
  const currentPages = () => $("designExportScope").value === "all" ? snapshot : snapshot.filter(p => selectedIds.includes(p.id));
  function update() {
    const { pages, loading } = getContext();
    $("exportSelectionButton").disabled = !pages.length || loading || busy;
  }
  function refresh() {
    const pages = currentPages(), format = $("designExportFormat").value, raster = ["png", "jpg"].includes(format);
    $("designExportScaleField").hidden = !raster;
    $("designExportTransparentField").hidden = format !== "png";
    const scale = raster ? Number($("designExportScale").value) : 1;
    $("designExportSummary").textContent = pages.length === 1
      ? `${pages[0].name} · ${pages[0].width * scale} × ${pages[0].height * scale}${raster ? " px" : ""}`
      : `${pages.length} 张画板 · ZIP 打包`;
    $("designExportSubmit").disabled = busy || !pages.length;
  }
  async function open(ids) {
    if (busy || beforeOpen && !await beforeOpen()) return;
    const context = getContext();
    snapshot = context.pages.map(page => ({ ...page }));
    selectedIds = ids || context.selectedIds;
    if (!snapshot.length) return;
    const count = snapshot.filter(page => selectedIds.includes(page.id)).length;
    const selected = $("designExportScope").options[0];
    selected.textContent = `选中画板（${count}）`; selected.disabled = !count;
    $("designExportScope").options[1].textContent = `当前画布全部（${snapshot.length}）`;
    $("designExportScope").value = count ? "selected" : "all";
    $("designExportError").hidden = true;
    refresh(); dialog.showModal();
  }
  for (const id of ["designExportScope", "designExportFormat", "designExportScale"]) $(id).addEventListener("change", refresh);
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  $("designExportCancel").addEventListener("click", () => { if (!busy) dialog.close(); });
  $("designExportForm").addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return;
    const pages = currentPages(); if (!pages.length) return;
    busy = true; update(); refresh();
    $("designExportSubmit").textContent = "正在导出…";
    $("designExportCancel").disabled = true;
    $("designExportClose").disabled = true;
    $("designExportError").hidden = true;
    for (const id of ["designExportScope", "designExportFormat", "designExportScale", "designExportTransparent"]) $(id).disabled = true;
    try {
      const response = await fetch(`/api/design/export?path=${encodeURIComponent(getContext().path)}`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Design-Client": "workbench-v1" },
        body: JSON.stringify({ pages, format: $("designExportFormat").value, scale: Number($("designExportScale").value), transparent: $("designExportTransparent").checked }),
      });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || "导出失败，请重试"); }
      const blob = await response.blob();
      const filename = response.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const link = document.createElement("a"), objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl; link.download = filename ? decodeURIComponent(filename) : "设计导出.zip";
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      dialog.close(); toast(`已导出 ${pages.length} 张画板`);
    } catch (error) { $("designExportError").textContent = error.message; $("designExportError").hidden = false; }
    finally {
      busy = false; $("designExportSubmit").textContent = "导出";
      $("designExportCancel").disabled = false; $("designExportClose").disabled = false;
      for (const id of ["designExportScope", "designExportFormat", "designExportScale", "designExportTransparent"]) $(id).disabled = false;
      update(); refresh();
    }
  });
  $("exportSelectionButton").addEventListener("click", () => void open());
  return { open, update };
}
