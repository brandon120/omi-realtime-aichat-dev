# Omi AI Chat Plugin - System Flow Diagram

## Complete System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           OMI AI CHAT PLUGIN - OPTIMIZED                        │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌─────────────┐
│   Omi App   │───▶│  Webhook     │───▶│  Request    │───▶│ Performance │
│             │    │  Handler     │    │  Processing │    │  Tracking   │
└─────────────┘    └──────────────┘    └─────────────┘    └─────────────┘
                           │
                           ▼
                   ┌──────────────┐
                   │   Command    │
                   │  Detection   │
                   └──────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Memory    │    │     Help    │    │    AI       │
│ Operations  │    │   Response  │    │ Processing  │
└─────────────┘    └─────────────┘    └─────────────┘
        │                                      │
        ▼                                      ▼
┌─────────────┐                        ┌─────────────┐
│ Local First │                        │ Smart Context│
│   Storage   │                        │  Detection  │
└─────────────┘                        └─────────────┘
        │                                      │
        ▼                                      ▼
┌─────────────┐                        ┌─────────────┐
│ Async       │                        │ Memory      │
│ ChromaDB    │                        │ Search      │
│ Backup      │                        └─────────────┘
└─────────────┘                                │
                                               ▼
                                        ┌─────────────┐
                                        │ Local Search│
                                        │ First       │
                                        └─────────────┘
                                               │
                                               ▼
                                        ┌─────────────┐
                                        │ ChromaDB    │
                                        │ Fallback    │
                                        └─────────────┘
```

## Memory System Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MEMORY SYSTEM FLOW                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Memory    │───▶│   Local     │───▶│  Embedding  │───▶│   ChromaDB  │
│   Input     │    │  Storage    │    │ Generation  │    │   Backup    │
│             │    │  (Fast)     │    │  (Async)    │    │  (Async)    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                           │
                           ▼
                   ┌─────────────┐
                   │   Memory    │
                   │   Index     │
                   │ (Category)  │
                   └─────────────┘

┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Search    │───▶│   Local     │───▶│  Results    │───▶│   Return    │
│   Query     │    │  Search     │    │  Found?     │    │  Results    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                           │                  │
                           │                  ▼
                           │            ┌─────────────┐
                           │            │   ChromaDB  │
                           │            │   Fallback  │
                           │            └─────────────┘
                           │
                           ▼
                   ┌─────────────┐
                   │   Scoring   │
                   │  Algorithm  │
                   └─────────────┘
```

## Performance Optimization Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         PERFORMANCE OPTIMIZATION FLOW                           │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Request   │───▶│   Smart     │───▶│   Cache     │───▶│   Fast      │
│  Received   │    │  Detection  │    │   Check     │    │ Response    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                           │
                           ▼
                   ┌─────────────┐
                   │   Skip      │
                   │ Unnecessary │
                   │ Operations  │
                   └─────────────┘

┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Background  │───▶│   Session   │───▶│   Memory    │───▶│   Cache     │
│  Cleanup    │    │  Cleanup    │    │  Cleanup    │    │  Cleanup    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘

┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Performance │───▶│   Metrics   │───▶│   Real-time │───▶│   Monitoring│
│  Tracking   │    │ Collection  │    │  Updates    │    │  Dashboard  │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

## Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DATA FLOW ARCHITECTURE                             │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────┐
│   User      │
│  Request    │
└─────────────┘
       │
       ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Session    │───▶│  Transcript │───▶│  Command    │
│ Management  │    │ Processing  │    │ Detection   │
└─────────────┘    └─────────────┘    └─────────────┘
       │
       ▼
┌─────────────┐
│  Memory     │
│ Operations  │
└─────────────┘
       │
   ┌───┴───┐
   │       │
   ▼       ▼
┌─────┐ ┌─────┐
│Local│ │Chroma│
│Store│ │ DB  │
└─────┘ └─────┘
   │       │
   └───┬───┘
       │
       ▼
┌─────────────┐
│   AI        │
│ Processing  │
└─────────────┘
       │
       ▼
┌─────────────┐
│  Response   │
│ Generation  │
└─────────────┘
       │
       ▼
┌─────────────┐
│   Omi       │
│  Response   │
└─────────────┘
```

## Memory Storage Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            MEMORY STORAGE ARCHITECTURE                          │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────┐
│   Memory    │
│   Input     │
└─────────────┘
       │
       ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Local     │───▶│   Memory    │───▶│   Category  │
│  Storage    │    │   Index     │    │   Index     │
│ (Primary)   │    │ (Fast Lookup)│   │ (Fast Search)│
└─────────────┘    └─────────────┘    └─────────────┘
       │
       ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Embedding   │───▶│   Embedding │───▶│   ChromaDB  │
│ Generation  │    │    Cache    │    │   Backup    │
│  (Async)    │    │ (Prevent    │    │ (Persistence)│
└─────────────┘    │ Regeneration)│   └─────────────┘
                   └─────────────┘
```

## Performance Monitoring Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        PERFORMANCE MONITORING ARCHITECTURE                      │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Request   │───▶│ Performance │───▶│   Metrics   │───▶│  Monitoring │
│  Processing │    │  Tracking   │    │ Collection  │    │  Dashboard  │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                           │
                           ▼
                   ┌─────────────┐
                   │   Real-time │
                   │   Updates   │
                   └─────────────┘
                           │
                           ▼
                   ┌─────────────┐
                   │   /metrics  │
                   │  Endpoint   │
                   └─────────────┘
```

## Key Performance Improvements

### Before Optimization
```
Request → ChromaDB Query → OpenAI API → Response
         (Blocking)      (Every time)
```

### After Optimization
```
Request → Local Cache → Fast Response
         ↓
    ChromaDB (Async Backup)
         ↓
    OpenAI API (Cached)
```

## Memory Search Optimization

### Local Search Algorithm
1. **Exact Phrase Match**: 10 points
2. **Word Matches**: 1 point each
3. **Category Match**: 2 points
4. **Recency Bonus**: 0.2-0.5 points
5. **Sort by Score**: Return top results

### Search Flow
```
Query → Local Search → Results Found?
                    ↓ No
              ChromaDB Fallback → Results
```

## Cleanup Process

### Automatic Cleanup (Every 2 minutes)
1. **Session Cleanup**: Remove old transcripts
2. **Conversation Cleanup**: Remove inactive conversations
3. **Rate Limit Cleanup**: Remove old timestamps
4. **Cache Cleanup**: Remove excess cached data
5. **Memory Cleanup**: Enforce per-user limits

### Cleanup Triggers
- Session age > 5 minutes
- Conversation age > 30 minutes
- Cache size > 10,000 entries
- Memory count > 1,000 per user

This system architecture provides a comprehensive view of how the optimized Omi AI Chat Plugin works, from request processing to response generation, with all the performance optimizations and monitoring systems in place.