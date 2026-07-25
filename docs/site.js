const copyStatus = document.querySelector("#copy-status");
const copyButtons = document.querySelectorAll(".copy-button");

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy command was unavailable");
}

function copyValue(button) {
  if (button.dataset.copy) return button.dataset.copy;
  const target = document.getElementById(button.dataset.copyTarget ?? "");
  return target?.textContent ?? "";
}

function announceCopyStatus(message) {
  if (!copyStatus) return;
  copyStatus.textContent = "";
  window.requestAnimationFrame(() => {
    copyStatus.textContent = message;
  });
}

function resetCopyButton(button, label) {
  window.setTimeout(() => {
    button.childNodes[0].textContent = label;
    delete button.dataset.copied;
  }, 1800);
}

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const originalLabel = button.childNodes[0]?.textContent ?? "Copy";
    try {
      await copyText(copyValue(button));
      button.childNodes[0].textContent = "Copied";
      button.dataset.copied = "true";
      announceCopyStatus("Copied to clipboard");
      resetCopyButton(button, originalLabel);
    } catch {
      announceCopyStatus("Copy failed. Select the code and copy it manually.");
      button.childNodes[0].textContent = "Copy failed";
      resetCopyButton(button, originalLabel);
    }
  });
}
