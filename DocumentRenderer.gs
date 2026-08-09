<script>

function DocumentRenderer_render(doc) {

  if (!doc) {
    alert("Document is NULL");
    return;
  }

  const view = doc.view;

  if (!view) {
    alert("No view registered for: " + doc.type);
    return;
  }

  const modalTitle = document.getElementById("soModalTitle");
  const modalBody = document.getElementById("soModalBody");
  const modalFooter = document.getElementById("soModalFooter");

  modalTitle.textContent = view.title || doc.type;
  modalFooter.innerHTML = "";

  let html = `
    <table class="table table-sm table-bordered">
      <tbody>
  `;

  view.headerFields.forEach(field => {

    html += `
      <tr>
        <th style="width:220px">${field}</th>
        <td>${doc.header[field] ?? ""}</td>
      </tr>
    `;

  });

  html += `
      </tbody>
    </table>
  `;

  modalBody.innerHTML = html;

  document.getElementById("soModalOverlay").style.display = "flex";

  Object.entries(view.detailTables).forEach(

    ([tableName, tableConfig]) => {

        const rows =
            doc.details[tableName] || [];

        html += `
            <hr>

            <h4>${tableConfig.title}</h4>

            <table class="table table-sm table-striped table-bordered">

                <thead>

                    <tr>
        `;

        tableConfig.columns.forEach(col => {

            html += `<th>${col}</th>`;

        });

        html += `
                    </tr>

                </thead>

                <tbody>
        `;

        rows.forEach(row => {

            html += "<tr>";

            tableConfig.columns.forEach(col => {

                html += `
                    <td>
                        ${row[col] ?? ""}
                    </td>
                `;

            });

            html += "</tr>";

        });

        html += `
                </tbody>

            </table>
        `;

    }

);

}

</script>
