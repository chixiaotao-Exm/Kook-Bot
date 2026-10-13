-- MinimalGive extension. It observes existing game events and never grants
-- items or executes commands. Install only during a coordinated game restart.
local json = require("libs/Json")
local telemetry = {}
local ROOT = "/pal/Package/Pal/Binaries/Linux/ue4ss/kook"
local started, sequence = false, 0
local boot, root
local capabilities = {binding=false, announcements=false, player_deaths=false, player_kills=false}

local function integer(value)
    return type(value) == "number" and value == value and value == math.floor(value)
end

local function uid(state)
    if not (state and state:IsValid()) then return nil end
    local guid, parts = state.PlayerUId, {}
    if not guid then return nil end
    for _, key in ipairs({"A", "B", "C", "D"}) do
        local value = guid[key]
        if not integer(value) or value < -2147483648 or value > 4294967295 then return nil end
        if value < 0 then value = value + 4294967296 end
        parts[#parts + 1] = string.format("%08X", value)
    end
    local result = table.concat(parts)
    return result ~= string.rep("0", 32) and result or nil
end

local function writeAtomic(path, value)
    local file = assert(io.open(path .. ".tmp", "wb"))
    assert(file:write(json.encode(value) .. "\n"))
    assert(file:flush())
    assert(file:close())
    assert(os.rename(path .. ".tmp", path))
end

local function emit(kind, fields)
    if not started then return false end
    sequence = sequence + 1
    fields.version, fields.type, fields.time = 1, kind, os.time()
    fields.event_id = boot .. ":" .. tostring(sequence)
    local encoded = json.encode(fields)
    if #encoded > 16000 then return false end
    local file = assert(io.open(root .. "/events-" .. boot .. ".jsonl", "ab"))
    assert(file:write(encoded .. "\n"))
    assert(file:flush())
    assert(file:close())
    return true
end

function telemetry.onChat(pc, text)
    if not started or type(text) ~= "string" then return end
    local code = text:match("^!bind%s+([A-Za-z0-9]+)%s*$")
        or text:match("^!绑定%s+([A-Za-z0-9]+)%s*$")
    if not code or #code < 6 or #code > 32 then return end
    local playerUid = uid(pc.PlayerState)
    if not playerUid then return end
    emit("binding", {player_uid=playerUid, code=code:upper()})
    -- This confirms only the in-game proof was recorded. The bot separately
    -- checks challenge expiry and uniqueness before binding the account.
    pcall(function()
        require("libs/utils").announce(pc, "Binding proof received. Check KOOK for the result.")
    end)
end

local function announcementHook(_, _world, message)
    pcall(function()
        local value = message:get():ToString()
        if type(value) == "string" and #value > 0 then
            emit("announcement", {message=value:sub(1, 2000)})
        end
    end)
end

-- Event layout reference: dkoz/AdminCommands, libs/serverlogs.lua,
-- OnDeadCharacter(_, event): event:get().SelfActor and .LastAttacker.
-- Player-state evidence is required for BOTH sides of a PvP kill. We do not
-- assign a summoned Pal's damage to an owner by guessing ownership.
local function deathHook(_, parameter)
    pcall(function()
        local event = parameter:get()
        local victim = event.SelfActor
        if not (victim and victim:IsValid()) then return end
        local victimUid = uid(victim.PlayerState)
        if not victimUid then return end
        local fields = {victim_uid=victimUid}
        pcall(function() fields.victim_name = victim.PlayerState:GetPlayerName():ToString() end)
        pcall(function()
            local position = victim:K2_GetActorLocation()
            fields.position = {x=position.X,y=position.Y,z=position.Z}
        end)
        local killerUid
        pcall(function()
            local attacker = event.LastAttacker
            if attacker and attacker:IsValid() then
                killerUid = uid(attacker.PlayerState)
                if killerUid then fields.killer_name = attacker.PlayerState:GetPlayerName():ToString() end
            end
        end)
        if killerUid and killerUid ~= victimUid then
            fields.killer_uid = killerUid
            emit("player_kill", fields)
        else
            emit("player_death", fields)
        end
    end)
end

function telemetry.start(options)
    if started then return end
    options = options or {}
    root = options.root or ROOT
    local file = assert(io.open("/proc/sys/kernel/random/uuid", "rb"))
    boot = file:read(80):gsub("%s+", "")
    file:close()
    assert(boot:match("^[a-f0-9%-]+$"), "invalid boot identifier")
    assert(type(ExecuteInGameThreadWithDelay) == "function", "game-thread timer missing")
    -- Caller patches the existing validated chat hook to call onChat.
    capabilities.binding = true
    if options.announcements ~= false then
        capabilities.announcements = pcall(function()
            RegisterHook("/Script/Pal.PalUtility:SendSystemAnnounce", announcementHook)
        end)
    end
    -- Optional because the native death layout must be confirmed for each
    -- server build. Successful registration alone is not an E2E event test.
    if options.deaths == true then
        capabilities.player_deaths = pcall(function()
            RegisterHook("/Script/Pal.PalCharacter:OnDeadCharacter", deathHook)
        end)
        capabilities.player_kills = capabilities.player_deaths
    end
    started = true
    local function heartbeat()
        pcall(function()
            local value = {version=1,time=os.time(),boot_id=boot}
            for key, enabled in pairs(capabilities) do value[key] = enabled end
            writeAtomic(root .. "/heartbeat.json", value)
        end)
        local ok = pcall(ExecuteInGameThreadWithDelay, 10000, heartbeat)
        if not ok then started = false end
    end
    heartbeat()
end

return telemetry
