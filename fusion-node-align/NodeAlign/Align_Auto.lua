-- Node Align for Blackmagic Fusion (Fusion Studio and DaVinci Resolve's Fusion page)
-- Houdini-style aligning and spacing of selected nodes in the Flow (Nodes) view.
--
-- Anchor: the ACTIVE node (the one you clicked last, drawn with the highlighted
-- outline) stays put and the other selected nodes line up on it, like Houdini's
-- "hold A and drag from a node". If the active node is not selected, the first
-- node in reading order (leftmost, then topmost) is used.
--
-- Written for Fusion's LuaJIT (Lua 5.1). Works with Fusion 9+ and Resolve 16+.

local SPREAD_FACTOR  = 1.25   -- Spread: gaps grow by this factor
local TIGHTEN_FACTOR = 0.8    -- Tighten: gaps shrink by this factor
local MIN_GAP_X      = 1.0    -- Distribute: minimum horizontal step (1 = one node width)
local MIN_GAP_Y      = 1.0    -- Distribute: minimum vertical step (1 = one node row)

local function collect(comp, flow)
	local list = {}
	for _, tool in pairs(comp:GetToolList(true) or {}) do
		local p = flow:GetPosTable(tool)
		if p and p[1] and p[2] then
			list[#list + 1] = { tool = tool, x = p[1], y = p[2] }
		end
	end
	table.sort(list, function(a, b)
		if a.x ~= b.x then return a.x < b.x end
		return a.y < b.y
	end)
	return list
end

local function findAnchor(comp, nodes)
	local active = comp.ActiveTool
	if active then
		local name = active.Name
		for _, n in ipairs(nodes) do
			if n.tool.Name == name then return n end
		end
	end
	return nodes[1]
end

local function extent(nodes)
	local minX, maxX, minY, maxY = math.huge, -math.huge, math.huge, -math.huge
	for _, n in ipairs(nodes) do
		if n.x < minX then minX = n.x end
		if n.x > maxX then maxX = n.x end
		if n.y < minY then minY = n.y end
		if n.y > maxY then maxY = n.y end
	end
	return minX, maxX, minY, maxY
end

-- Spread nodes along one axis so every step is the same. The anchor stays in
-- place; the step is the current average, but never less than one node so
-- nothing overlaps.
local function distribute(nodes, anchor, key, minGap)
	if #nodes < 2 then return end
	local sorted = {}
	for i, n in ipairs(nodes) do sorted[i] = n end
	table.sort(sorted, function(a, b)
		if a[key] ~= b[key] then return a[key] < b[key] end
		return a.tool.Name < b.tool.Name
	end)
	local step = math.max((sorted[#sorted][key] - sorted[1][key]) / (#sorted - 1), minGap)
	local rank = 1
	for i, n in ipairs(sorted) do
		if n == anchor then rank = i end
	end
	local base = anchor[key]
	for i, n in ipairs(sorted) do
		n[key] = base + (i - rank) * step
	end
end

local function scale(nodes, anchor, factor)
	for _, n in ipairs(nodes) do
		n.x = anchor.x + (n.x - anchor.x) * factor
		n.y = anchor.y + (n.y - anchor.y) * factor
	end
end

-- Returns the nodes with new x/y; does not touch Fusion. Kept separate so it can be tested.
local function plan(mode, nodes, anchor)
	if mode == "auto" then
		local minX, maxX, minY, maxY = extent(nodes)
		mode = ((maxX - minX) >= (maxY - minY)) and "horizontal" or "vertical"
	end

	if mode == "horizontal" then          -- one row: same Y as anchor
		for _, n in ipairs(nodes) do n.y = anchor.y end
	elseif mode == "vertical" then        -- one column: same X as anchor
		for _, n in ipairs(nodes) do n.x = anchor.x end
	elseif mode == "straighten_h" then    -- row, then even spacing along it
		for _, n in ipairs(nodes) do n.y = anchor.y end
		distribute(nodes, anchor, "x", MIN_GAP_X)
	elseif mode == "straighten_v" then    -- column, then even spacing along it
		for _, n in ipairs(nodes) do n.x = anchor.x end
		distribute(nodes, anchor, "y", MIN_GAP_Y)
	elseif mode == "distribute_h" then
		distribute(nodes, anchor, "x", MIN_GAP_X)
	elseif mode == "distribute_v" then
		distribute(nodes, anchor, "y", MIN_GAP_Y)
	elseif mode == "spread" then
		scale(nodes, anchor, SPREAD_FACTOR)
	elseif mode == "tighten" then
		scale(nodes, anchor, TIGHTEN_FACTOR)
	else
		error("Node Align: unknown mode '" .. tostring(mode) .. "'")
	end
	return nodes
end

local function safe(fn)
	local ok, v = pcall(fn)
	if ok then return v end
	return nil
end

local function isFlow(v)
	return v ~= nil and safe(function() return v.GetPosTable end) ~= nil
end

-- Find the Nodes view. Fusion Studio and Resolve expose it in different ways,
-- so try several routes and report what was found if all of them fail.
local function findFlow(c)
	local tried = {}
	local function try(label, fn)
		local v = safe(fn)
		tried[#tried + 1] = label .. " = " .. tostring(v)
		if isFlow(v) then return v end
	end

	local frame = safe(function() return c.CurrentFrame end)
	local flow = try("comp.CurrentFrame.FlowView", function() return frame.FlowView end)
	if flow then return flow end

	local frames = safe(function() return c:GetFrameList() end) or {}
	for i, f in pairs(frames) do
		flow = try("frame[" .. tostring(i) .. "].FlowView", function() return f.FlowView end)
		if flow then return flow end
	end

	local all = {}
	if frame then all[#all + 1] = frame end
	for _, f in pairs(frames) do all[#all + 1] = f end
	for _, f in ipairs(all) do
		local views = safe(function() return f:GetViewList() end) or {}
		for id, v in pairs(views) do
			if string.find(string.lower(tostring(id)), "flow") then
				flow = try("view " .. tostring(id), function() return v end)
				if flow then return flow end
			end
		end
	end

	print("Node Align: no Nodes view found. Tried:")
	for _, t in ipairs(tried) do print("  " .. t) end
	local host = (fu or fusion or app)
	print("  host = " .. tostring(safe(function() return host:GetAttrs().FUSIONS_FileName end))
		.. ", version = " .. tostring(safe(function() return host:GetAttrs().FUSIONS_Version end)))
	return nil
end

local function run(mode)
	local c = comp or (fu and fu:GetCurrentComp()) or (fusion and fusion:GetCurrentComp())
	if not c then print("Node Align: no composition open") return end
	local flow = findFlow(c)
	if not flow then return end

	local nodes = collect(c, flow)
	if #nodes < 2 then print("Node Align: select at least two nodes") return end
	local anchor = findAnchor(c, nodes)

	plan(mode, nodes, anchor)

	c:StartUndo("Node Align (" .. mode .. ")")
	for _, n in ipairs(nodes) do
		flow:SetPos(n.tool, n.x, n.y)
	end
	c:EndUndo(true)
end

NodeAlign = { run = run, plan = plan }

NodeAlign.run("auto")
