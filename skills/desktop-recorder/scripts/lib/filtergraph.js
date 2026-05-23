// Filter fragment shape emitted by each stage's generate():
//   {
//     filters:     ["[in]...[out]", ...],   // joined with ';'
//     inputs:      ["[in]"],                 // labels consumed
//     outputs:     "[out]",                  // single label produced
//     extraInputs: [{ argv: ["-i", "/path"] }, ...],
//     sidecars:    { captions?, timewarp? }
//   }

function joinFilters(filters) { return filters.join(";"); }

module.exports = { joinFilters };
