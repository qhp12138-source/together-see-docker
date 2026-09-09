(function () {
  const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1000;

  function createRoomCredentialStore(roomCode, options) {
    const cleanRoomCode = String(roomCode || "");
    const local = options?.localStorage || window.localStorage;
    const session = options?.sessionStorage || window.sessionStorage;
    const now = typeof options?.now === "function" ? options.now : Date.now;
    const pendingTtlMs = Number(options?.pendingTtlMs) > 0 ? Number(options.pendingTtlMs) : DEFAULT_PENDING_TTL_MS;
    const keys = {
      activeToken: "together-see:room-admin:" + cleanRoomCode,
      activeRecovery: "together-see:room-admin-recovery:" + cleanRoomCode,
      pendingToken: "together-see:room-creation-token:" + cleanRoomCode,
      pendingRecovery: "together-see:room-creation-recovery:" + cleanRoomCode,
      pendingExpires: "together-see:room-creation-expires:" + cleanRoomCode,
    };

    function read(storage, key) {
      try { return storage?.getItem(key) || ""; } catch (error) { return ""; }
    }

    function writeVerified(storage, key, value) {
      try {
        if (storage?.getItem(key) === value) return true;
        storage?.setItem(key, value);
        return storage?.getItem(key) === value;
      } catch (error) {
        return false;
      }
    }

    function remove(storage, key) {
      try { storage?.removeItem(key); } catch (error) {}
    }

    function clearPending() {
      remove(local, keys.pendingToken);
      remove(local, keys.pendingRecovery);
      remove(local, keys.pendingExpires);
    }

    function getPending() {
      const adminToken = read(local, keys.pendingToken);
      const recoveryCode = read(local, keys.pendingRecovery);
      const rawExpiresAt = read(local, keys.pendingExpires);
      if (!adminToken || !recoveryCode) {
        if (adminToken || recoveryCode || rawExpiresAt) clearPending();
        return null;
      }

      let expiresAt = Number(rawExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
        expiresAt = now() + pendingTtlMs;
        if (!writeVerified(local, keys.pendingExpires, String(expiresAt))) return null;
      }
      if (expiresAt <= now()) {
        clearPending();
        return null;
      }
      return { adminToken, recoveryCode, expiresAt };
    }

    function savePending(adminToken, recoveryCode) {
      const cleanToken = String(adminToken || "");
      const cleanRecovery = String(recoveryCode || "");
      const expiresAt = now() + pendingTtlMs;
      if (!cleanToken || !cleanRecovery
        || !writeVerified(local, keys.pendingToken, cleanToken)
        || !writeVerified(local, keys.pendingRecovery, cleanRecovery)
        || !writeVerified(local, keys.pendingExpires, String(expiresAt))) {
        throw new Error("浏览器无法保存房间创建凭据");
      }
      return { adminToken: cleanToken, recoveryCode: cleanRecovery, expiresAt };
    }

    function saveActiveToken(adminToken) {
      const cleanToken = String(adminToken || "");
      if (!cleanToken) {
        remove(session, keys.activeToken);
        remove(local, keys.activeToken);
        return true;
      }
      const verified = writeVerified(session, keys.activeToken, cleanToken);
      if (verified) remove(local, keys.activeToken);
      return verified;
    }

    function saveActiveRecovery(recoveryCode) {
      const cleanRecovery = String(recoveryCode || "");
      if (!cleanRecovery) {
        remove(local, keys.activeRecovery);
        return true;
      }
      return writeVerified(local, keys.activeRecovery, cleanRecovery);
    }

    function stageCreated(adminToken, recoveryCode) {
      const pending = savePending(adminToken, recoveryCode);
      const sessionVerified = saveActiveToken(pending.adminToken);
      const recoveryVerified = saveActiveRecovery(pending.recoveryCode);
      return { ...pending, sessionVerified, recoveryVerified };
    }

    function loadAdminToken() {
      let adminToken = read(session, keys.activeToken);
      if (adminToken) {
        remove(local, keys.activeToken);
        return adminToken;
      }
      adminToken = read(local, keys.activeToken) || getPending()?.adminToken || "";
      if (adminToken) saveActiveToken(adminToken);
      return adminToken;
    }

    function loadRecoveryCode() {
      return read(local, keys.activeRecovery) || getPending()?.recoveryCode || "";
    }

    function finalizeCreated(adminToken, recoveryCode) {
      const cleanToken = String(adminToken || "");
      const pending = getPending();
      const sessionVerified = saveActiveToken(cleanToken);
      const recoveryVerified = recoveryCode ? saveActiveRecovery(recoveryCode) : true;
      const matchesPending = Boolean(pending && cleanToken && pending.adminToken === cleanToken);
      if (matchesPending && sessionVerified && recoveryVerified) clearPending();
      return { matchesPending, sessionVerified, recoveryVerified, cleared: matchesPending && sessionVerified && recoveryVerified };
    }

    return {
      clearPending,
      finalizeCreated,
      getPending,
      loadAdminToken,
      loadRecoveryCode,
      saveActiveRecovery,
      saveActiveToken,
      savePending,
      stageCreated,
    };
  }

  window.TogetherSeeCredentials = {
    createRoomCredentialStore,
    pendingTtlMs: DEFAULT_PENDING_TTL_MS,
  };
})();
