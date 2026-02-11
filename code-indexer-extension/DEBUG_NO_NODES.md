# Quick Debugging Steps

## Issue: No nodes showing in graph

### Step 1: Check Browser Console
1. Open the Code Graph panel in VS Code
2. Right-click in the webview → "Inspect Element" or press `Ctrl+Shift+I`
3. Look for errors in the Console tab

### Step 2: Check if data is loading
In the browser console, type:
```javascript
// Check if graph data exists
console.log('Graph data loaded:', window.graphData);

// Check React Flow instance
console.log('Nodes:', document.querySelectorAll('[data-id]').length);
```

### Step 3: Check filtering
```javascript
// Enable performance monitor
window.perfMonitor.enable();

// Check if filtering is working
// You should see filter timing logs
```

### Step 4: Common Issues

#### Issue: "Cannot read property 'opacity' of undefined"
**Cause:** Nodes don't have data property initialized
**Fix:** Already fixed in latest build - nodes are now always cloned on first render

#### Issue: "visibleNodes is empty"
**Cause:** Filtering is removing all nodes
**Fix:** Check the current view mode - Architecture mode hides symbol nodes

#### Issue: "Layout failed" error
**Cause:** ELK layout error
**Fix:** Check if nodes have valid positions

### Step 5: Force Reload
1. Close the Code Graph panel
2. Run command: "Developer: Reload Window" (Ctrl+R in VS Code)
3. Reopen Code Graph panel

### Step 6: Check Extension Output
1. View → Output
2. Select "Code Indexer Extension" from dropdown
3. Look for errors

## Expected Console Output (Normal)

When graph loads successfully, you should see:
```
✓ filter took 8.23ms
✓ layout took 245.67ms
```

## If Still Not Working

Please provide:
1. Screenshot of browser console errors
2. Output from: `console.log(window.perfMonitor.getAverageMetrics())`
3. Current view mode
4. Number of files indexed
