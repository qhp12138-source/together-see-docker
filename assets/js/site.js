(function () {
  const MEMBER_NAME_KEY = "together-see:member-name";
  const ROOM_PASSWORD_PREFIX = "together-see:room-password:";

  function normalizeRoomName(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[?#&=\\/:;%]/g, "")
      .slice(0, 64)
      .trim();
  }

  function normalizeNickname(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 24);
  }

  function getRoomCredentialStore(roomName) {
    if (!window.TogetherSeeCredentials?.createRoomCredentialStore) {
      throw new Error("房间凭据组件未加载，请刷新页面后重试");
    }
    return window.TogetherSeeCredentials.createRoomCredentialStore(roomName);
  }

  function goRoom(roomName, options) {
    const clean = normalizeRoomName(roomName);
    if (!clean) return false;
    const query = new URLSearchParams({ room: clean });
    if (options?.created === true) query.set("created", "1");
    window.location.href = "./room.html?" + query.toString();
    return true;
  }

  function saveNickname(value) {
    const nickname = normalizeNickname(value);
    if (!nickname) return;
    try { window.localStorage.setItem(MEMBER_NAME_KEY, nickname); } catch (error) {}
  }

  function saveRoomPassword(roomName, password) {
    try {
      if (password) window.sessionStorage.setItem(ROOM_PASSWORD_PREFIX + roomName, password);
      else window.sessionStorage.removeItem(ROOM_PASSWORD_PREFIX + roomName);
      window.localStorage.removeItem(ROOM_PASSWORD_PREFIX + roomName);
    } catch (error) {}
  }

  function saveRoomAdminCredentials(roomName, adminToken, recoveryCode) {
    if (!adminToken || !recoveryCode) throw new Error("房间管理凭据生成失败，请重新创建房间");
    try {
      getRoomCredentialStore(roomName).stageCreated(adminToken, recoveryCode);
    } catch (error) {
      throw new Error("浏览器无法保存房间管理凭据，请允许本站使用本地存储后重试");
    }
  }

  function randomUrlSafeToken(byteLength) {
    if (!window.crypto?.getRandomValues || typeof window.btoa !== "function") {
      throw new Error("当前浏览器无法安全创建房间，请升级浏览器后重试");
    }
    const bytes = new Uint8Array(byteLength);
    window.crypto.getRandomValues(bytes);
    let binary = "";
    bytes.forEach(function (value) { binary += String.fromCharCode(value); });
    return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function randomRecoveryCode() {
    if (!window.crypto?.getRandomValues) {
      throw new Error("当前浏览器无法安全创建房间，请升级浏览器后重试");
    }
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(25);
    window.crypto.getRandomValues(bytes);
    const raw = Array.from(bytes, function (value) { return alphabet[value & 31]; }).join("");
    return raw.match(/.{1,5}/g)?.join("-") || raw;
  }

  function getOrCreateRoomCredentials(roomName) {
    try {
      const store = getRoomCredentialStore(roomName);
      const pending = store.getPending();
      if (pending) return { adminToken: pending.adminToken, recoveryCode: pending.recoveryCode };
      const adminToken = randomUrlSafeToken(24);
      const recoveryCode = randomRecoveryCode();
      store.savePending(adminToken, recoveryCode);
      return { adminToken: adminToken, recoveryCode: recoveryCode };
    } catch (error) {
      if (/当前浏览器/.test(error?.message || "")) throw error;
      throw new Error("浏览器无法保存房间管理凭据，请允许本站使用本地存储后重试");
    }
  }

  function clearPendingRoomCredentials(roomName) {
    try { getRoomCredentialStore(roomName).clearPending(); } catch (error) {}
  }

  function setError(node, message) {
    if (node) node.textContent = message || "";
  }

  function getFocusable(modal) {
    return Array.from(modal.querySelectorAll("button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"));
  }

  let activeModal = null;
  let modalReturnFocus = null;
  let pendingRoomName = "";
  let activeRequest = null;

  function openModal(modal, roomName, focusTarget) {
    if (!modal) return;
    pendingRoomName = roomName;
    modalReturnFocus = document.activeElement;
    activeModal = modal;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("has-open-dialog");
    window.setTimeout(function () { focusTarget?.focus(); }, 20);
  }

  function closeModal(modal, options) {
    if (!modal || modal.hidden) return;
    if (activeRequest?.modal === modal) activeRequest.controller.abort();
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    if (activeModal === modal) activeModal = null;
    document.body.classList.remove("has-open-dialog");
    if (options?.restoreFocus !== false) modalReturnFocus?.focus?.();
    modalReturnFocus = null;
  }

  function handleModalKeydown(event) {
    if (!activeModal) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal(activeModal);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = getFocusable(activeModal);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const joinForm = document.querySelector("[data-room-form]");
  const createForm = document.querySelector("[data-create-room-form]");
  const createModal = document.querySelector("[data-home-create-modal]");
  const joinModal = document.querySelector("[data-home-join-modal]");
  const createDialogForm = document.querySelector("[data-home-create-dialog-form]");
  const joinDialogForm = document.querySelector("[data-home-join-dialog-form]");
  const createNickname = document.querySelector("[data-home-create-nickname]");
  const joinNickname = document.querySelector("[data-home-join-nickname]");
  const createPassword = document.querySelector("[data-home-create-password]");
  const createSubmit = document.querySelector("[data-home-create-submit]");
  const joinSubmit = document.querySelector("[data-home-join-submit]");
  const createFormError = document.querySelector("[data-create-room-error]");
  const joinFormError = document.querySelector("[data-join-room-error]");
  const createDialogError = document.querySelector("[data-home-create-dialog-error]");
  const joinDialogError = document.querySelector("[data-home-join-dialog-error]");

  if (joinForm) {
    joinForm.addEventListener("submit", function (event) {
      event.preventDefault();
      const input = joinForm.querySelector("input[name='room']");
      const roomName = normalizeRoomName(input?.value);
      setError(joinFormError, "");
      if (!roomName) {
        setError(joinFormError, "请输入要加入的房间名");
        input?.focus();
        return;
      }
      pendingRoomName = roomName;
      const label = joinModal?.querySelector("[data-home-join-room-name]");
      if (label) label.textContent = roomName;
      setError(joinDialogError, "");
      if (joinNickname) joinNickname.value = "";
      openModal(joinModal, roomName, joinNickname);
    });
  }

  if (createForm) {
    createForm.addEventListener("submit", function (event) {
      event.preventDefault();
      const input = createForm.querySelector("input[name='roomName']");
      const roomName = normalizeRoomName(input?.value);
      setError(createFormError, "");
      if (!roomName) {
        setError(createFormError, "请输入要创建的房间名");
        input?.focus();
        return;
      }
      pendingRoomName = roomName;
      const label = createModal?.querySelector("[data-home-create-room-name]");
      if (label) label.textContent = roomName;
      setError(createDialogError, "");
      if (createNickname) createNickname.value = "";
      if (createPassword) createPassword.value = "";
      openModal(createModal, roomName, createNickname);
    });
  }

  joinDialogForm?.addEventListener("submit", async function (event) {
    event.preventDefault();
    const roomName = pendingRoomName;
    if (!roomName) {
      setError(joinDialogError, "房间名无效，请返回重试");
      return;
    }
    setError(joinDialogError, "");
    if (joinSubmit) {
      joinSubmit.disabled = true;
      joinSubmit.textContent = "检查中...";
    }
    try {
      const controller = new AbortController();
      activeRequest = { modal: joinModal, controller: controller };
      const response = await fetch("/api/rooms/" + encodeURIComponent(roomName), { signal: controller.signal });
      const result = await response.json().catch(function () { return {}; });
      if (!response.ok || result?.success !== true) {
        throw new Error(result?.message || "房间查询失败，请稍后重试");
      }
      if (result.exists !== true || !result.room) {
        closeModal(joinModal, { restoreFocus: false });
        setError(joinFormError, "房间不存在或已经销毁，请重新输入或者创建房间");
        const input = joinForm?.querySelector("input[name='room']");
        input?.focus();
        input?.select();
        return;
      }
      saveNickname(joinNickname?.value);
      goRoom(result.room.roomCode || roomName);
    } catch (error) {
      if (error?.name === "AbortError") return;
      setError(joinDialogError, error?.message || "房间查询失败，请检查网络后重试");
    } finally {
      if (activeRequest?.modal === joinModal) activeRequest = null;
      if (joinSubmit) {
        joinSubmit.disabled = false;
        joinSubmit.textContent = "加入房间";
      }
    }
  });

  createDialogForm?.addEventListener("submit", async function (event) {
    event.preventDefault();
    const roomName = pendingRoomName;
    const password = String(createPassword?.value || "").trim();
    setError(createDialogError, "");
    if (!roomName) {
      setError(createDialogError, "房间名无效，请返回重试");
      return;
    }
    if (password && password.length < 4) {
      setError(createDialogError, "房间密码至少需要 4 个字符，或留空不设置密码");
      createPassword?.focus();
      return;
    }

    if (createSubmit) {
      createSubmit.disabled = true;
      createSubmit.textContent = "创建中...";
    }
    try {
      const credentials = getOrCreateRoomCredentials(roomName);
      const controller = new AbortController();
      activeRequest = { modal: createModal, controller: controller };
      const response = await fetch("/api/rooms/" + encodeURIComponent(roomName), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          roomName: roomName,
          password: password,
          adminToken: credentials.adminToken,
          recoveryCode: credentials.recoveryCode,
        }),
      });
      const result = await response.json().catch(function () { return {}; });
      if (response.status === 409 || result?.code === "room_exists") {
        clearPendingRoomCredentials(roomName);
        closeModal(createModal, { restoreFocus: false });
        setError(createFormError, "同名房间已存在，请重新输入或者加入房间");
        const input = createForm?.querySelector("input[name='roomName']");
        input?.focus();
        input?.select();
        return;
      }
      if (!response.ok || result?.success !== true) {
        if (result?.code === "creation_credentials_invalid") clearPendingRoomCredentials(roomName);
        throw new Error(result?.message || "房间创建失败，请稍后重试");
      }
      const canonicalRoomName = result.room?.roomCode || roomName;
      saveRoomAdminCredentials(canonicalRoomName, result.adminToken || credentials.adminToken, result.recoveryCode || credentials.recoveryCode);
      if (canonicalRoomName !== roomName) clearPendingRoomCredentials(roomName);
      saveNickname(createNickname?.value);
      saveRoomPassword(canonicalRoomName, password);
      goRoom(canonicalRoomName, { created: true });
    } catch (error) {
      if (error?.name === "AbortError") return;
      setError(createDialogError, error?.message || "房间创建失败，请检查网络后重试");
    } finally {
      if (activeRequest?.modal === createModal) activeRequest = null;
      if (createSubmit) {
        createSubmit.disabled = false;
        createSubmit.textContent = "创建并进入";
      }
    }
  });

  document.querySelectorAll("[data-home-modal-cancel]").forEach(function (button) {
    button.addEventListener("click", function () {
      closeModal(button.closest("[data-home-create-modal], [data-home-join-modal]"));
    });
  });
  document.addEventListener("keydown", handleModalKeydown);
})();
