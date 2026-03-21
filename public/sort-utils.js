/**
 * sort-utils.js — Tüm tablolara tıklanabilir başlık sıralaması ekler.
 * Kullanım: <script src="sort-utils.js"></script> yeterli, başka çağrı gerekmez.
 * Manuel çağrı: initSortable('tableId') — dinamik yüklenen tablolar için.
 */
(function () {
    const SKIP_TEXTS = ['', 'i̇şlemler', 'işlemler'];

    function parseTrDate(s) {
        const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
    }

    function sortByCol(table, colIdx, th) {
        const asc = th.dataset.sort !== 'asc';

        // Tüm başlıkları sıfırla
        table.querySelectorAll('thead tr:first-child th').forEach(h => {
            h.dataset.sort = '';
            const ic = h.querySelector('.sort-icon');
            if (ic) { ic.textContent = '⇅'; ic.style.color = '#94a3b8'; }
        });

        th.dataset.sort = asc ? 'asc' : 'desc';
        const ic = th.querySelector('.sort-icon');
        if (ic) { ic.textContent = asc ? ' ▲' : ' ▼'; ic.style.color = '#1e3a8a'; }

        const tbody = table.querySelector('tbody');
        const rows = [...tbody.querySelectorAll('tr')].filter(r =>
            !r.classList.contains('history-row') &&
            !r.classList.contains('detail-row') &&
            !(r.id && r.id.startsWith('tarihce-'))
        );

        rows.sort((a, b) => {
            const aText = (a.cells[colIdx]?.innerText || '').trim();
            const bText = (b.cells[colIdx]?.innerText || '').trim();

            // Türkçe tarih dd.mm.yyyy
            const ad = parseTrDate(aText), bd = parseTrDate(bText);
            if (ad && bd) return asc ? ad - bd : bd - ad;

            // Sayı
            const an = parseFloat(aText.replace(/[^\d,.-]/g, '').replace(',', '.'));
            const bn = parseFloat(bText.replace(/[^\d,.-]/g, '').replace(',', '.'));
            if (!isNaN(an) && !isNaN(bn)) return asc ? an - bn : bn - an;

            // Metin (Türkçe)
            return asc
                ? aText.localeCompare(bText, 'tr', { sensitivity: 'base' })
                : bText.localeCompare(aText, 'tr', { sensitivity: 'base' });
        });

        rows.forEach(r => tbody.appendChild(r));
    }

    function initTable(table) {
        if (table.dataset.sortInit) return;
        table.dataset.sortInit = '1';
        table.querySelectorAll('thead tr:first-child th').forEach((th, i) => {
            const txt = th.textContent.trim().toLowerCase();
            if (th.hasAttribute('data-nosort') || SKIP_TEXTS.includes(txt)) return;

            th.style.cursor = 'pointer';
            th.style.userSelect = 'none';
            const icon = document.createElement('span');
            icon.className = 'sort-icon';
            icon.style.cssText = 'font-size:0.65rem;margin-left:3px;vertical-align:middle;color:#94a3b8;';
            icon.textContent = '⇅';
            th.appendChild(icon);
            th.addEventListener('click', () => sortByCol(table, i, th));
        });
    }

    function autoInit() {
        document.querySelectorAll('table').forEach(t => {
            if (t.querySelector('thead') && t.querySelector('tbody')) initTable(t);
        });
    }

    // Manuel çağrı için (dinamik tablolar)
    window.initSortable = function (tableId) {
        const t = typeof tableId === 'string' ? document.getElementById(tableId) : tableId;
        if (t) initTable(t);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        autoInit();
    }
})();
