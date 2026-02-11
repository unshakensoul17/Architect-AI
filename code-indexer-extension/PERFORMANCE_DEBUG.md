# Performance Debugging Quick Reference

## 🚀 Quick Diagnosis

### Step 1: Enable Performance Monitor
Open browser DevTools console (F12) and run:
```javascript
window.perfMonitor.enable()
```

### Step 2: Interact with Graph
- Switch between view modes
- Click nodes in Impact mode
- Pan and zoom

### Step 3: Check Report
```javascript
window.perfMonitor.printReport()
```

---

## 📊 Interpreting Results

### Good Performance (60 FPS)
```
Filter Time:  < 16ms  ✅
Layout Time:  200-500ms (only on mode change) ✅
Render Time:  < 16ms  ✅
Est. FPS:     > 50    ✅
```

### Warning Signs
```
Filter Time:  > 50ms   ⚠️ Check for object cloning
Layout Time:  > 500ms  ⚠️ Too many nodes or infinite loop
Render Time:  > 30ms   ⚠️ React Flow performance issue
Est. FPS:     < 30     ⚠️ User will notice lag
```

---

## 🔍 Common Issues

### Issue: Filter Time > 50ms
**Cause:** Object cloning on every render  
**Check:** Look for nodes/edges being cloned unnecessarily  
**Fix:** Add early return if state unchanged

### Issue: Layout Running Continuously
**Cause:** Infinite render loop  
**Check:** Console should show "layout" timer repeatedly  
**Fix:** Check useEffect dependencies in GraphCanvas.tsx

### Issue: Memory Growing
**Cause:** Cache not being cleared  
**Check:** DevTools Memory tab  
**Fix:** Call `clearRelationshipCache()` and `clearLayoutCache()`

---

## 🛠️ Debug Commands

### Clear All Caches
```javascript
// In browser console
window.clearAllCaches = () => {
    // You'll need to expose these functions
    console.log('Caches cleared');
}
```

### Force Re-render
```javascript
// Switch modes rapidly to test debouncing
['architecture', 'flow', 'risk', 'impact'].forEach((mode, i) => {
    setTimeout(() => console.log('Switching to', mode), i * 100);
});
```

### Monitor React Flow
```javascript
// Check React Flow instance
window.reactFlowInstance = reactFlowInstance;
console.log('Nodes:', window.reactFlowInstance.getNodes().length);
console.log('Edges:', window.reactFlowInstance.getEdges().length);
```

---

## 📈 Performance Targets

| Graph Size | Filter Time | Layout Time | Target FPS |
|------------|-------------|-------------|------------|
| < 100 nodes | < 5ms | < 100ms | 60 FPS |
| 100-500 nodes | < 15ms | 200-300ms | 50-60 FPS |
| 500-1000 nodes | < 30ms | 300-500ms | 30-50 FPS |
| > 1000 nodes | < 50ms | 500-1000ms | 20-30 FPS |

---

## 🐛 Troubleshooting Checklist

- [ ] Build succeeded without errors
- [ ] No console errors in browser
- [ ] Performance monitor is enabled
- [ ] Filter time is < 16ms for unchanged state
- [ ] Layout only runs once per mode change
- [ ] No infinite loop warnings in console
- [ ] FPS is > 30 for graphs with < 500 nodes
- [ ] Memory usage is stable (not growing)

---

## 📝 Reporting Issues

If performance is still poor, collect this data:

```javascript
// Run this in console
const report = {
    nodeCount: window.reactFlowInstance?.getNodes().length,
    edgeCount: window.reactFlowInstance?.getEdges().length,
    performance: window.perfMonitor.getAverageMetrics(),
    browser: navigator.userAgent,
};
console.log(JSON.stringify(report, null, 2));
```

Copy the output and include:
1. What action triggered the lag
2. Current view mode
3. Graph size (nodes/edges)
4. Performance metrics
