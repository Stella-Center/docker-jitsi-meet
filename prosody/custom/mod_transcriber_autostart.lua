local LOGLEVEL = "info"

local is_admin = require "core.usermanager".is_admin
local is_healthcheck_room = module:require "util".is_healthcheck_room
local timer = require "util.timer"
local st = require "util.stanza"
local uuid = require "util.uuid".generate
local util = module:require "util";
local get_room_from_jid = util.get_room_from_jid;
module:log(LOGLEVEL, "loaded")

local main_muc_service;

local muc_domain_base = module:get_option_string("muc_mapper_domain_base");

-- This module chooses jigasi from the brewery room, so it needs information for the configured brewery
local muc_domain = module:get_option_string("muc_internal_domain_base", 'internal.auth.' .. muc_domain_base);

local jigasi_brewery_room_jid = module:get_option_string("muc_jigasi_brewery_jid", 'jigasibrewery@' .. muc_domain);
local jigasi_bare_jid = module:get_option_string("muc_jigasi_jid", "jigasi@auth." .. muc_domain_base);
local focus_jid = module:get_option_string("muc_jicofo_brewery_jid", jigasi_brewery_room_jid .. "/focus");

-- -----------------------------------------------------------------------------
local function _is_admin(jid)
    return is_admin(jid, module.host)
end

-- -----------------------------------------------------------------------------
local function _start_recording(room, session, stanza)
    local jigasi_brewery_room = get_room_from_jid(jigasi_brewery_room_jid);
    
    -- Ensure that the brewery room is valid
    if not jigasi_brewery_room then
        module:log("error", "Failed to get Jigasi brewery room from JID: %s", jigasi_brewery_room_jid);
        return
    end

    -- Customize Jigasi JID to the one set up in your environment
    local jigasi_bare_jid = module:get_option_string("muc_jigasi_jid", "jigasi@auth." .. muc_domain_base);
    
    module:log("info", "Inviting Jigasi for transcription to room: %s", room.jid);
    module:log("info", "Jigasi Brewery Room JID: %s", jigasi_brewery_room.jid);
    module:log("info", "Jigasi Bare JID: %s", jigasi_bare_jid);

    -- Create a presence stanza for Jigasi
    local jigasi_presence = st.presence({ from = jigasi_bare_jid, to = jigasi_brewery_room.jid })
        :tag("x", { xmlns = "http://jabber.org/protocol/muc" })

    -- Route the presence stanza to the Jigasi brewery room
    module:log("info", "Routing presence to Jigasi Brewery Room: %s", jigasi_brewery_room.jid);
    room:route_stanza(jigasi_presence)  -- Use route_stanza instead of send

    -- Optionally, send a message indicating transcription has started
    local message = st.message({ type="groupchat", from = jigasi_bare_jid, to = room.jid })
        :tag("body"):text("Transcription service has been activated for this room.")
    
    module:log("info", "Sending message to room: %s", room.jid);
    room:route_stanza(message)

    return
end
-- -----------------------------------------------------------------------------
module:hook("muc-room-created", function (event)
    local room = event.room
    local stanza = event.stanza
    local session = event.origin

    -- wait for the affiliation to set then start recording if applicable
    timer.add_task(3, function()
        _start_recording(room, session, stanza)
    end)
end)