import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, TextInput, FlatList, ActivityIndicator, KeyboardAvoidingView, Platform, useWindowDimensions, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/Themed';
import { useAuth } from '@/contexts/AuthContext';
import {
  apiListMessages,
  apiSendMessage,
  apiCreateFollowup,
  apiSwitchSpace,
  apiActivateWindow,
  apiCreateMemory,
  apiCreateTask,
  apiMe,
  apiListWindows,
  type MessageItem
} from '@/lib/api';
// Slash commands use apiSwitchSpace/apiActivateWindow/apiCreateMemory/apiCreateTask/apiCreateFollowup

type MessageState = {
  byConversationId: Record<string, { items: MessageItem[]; nextCursor: string | null; loading: boolean }>
}

export default function ChatScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageState>({ byConversationId: {} });
  const [input, setInput] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const sendingGuardRef = useRef<boolean>(false);
  const lastSentRef = useRef<{ text: string; ts: number } | null>(null);
  const pollingRef = useRef<any>(null);
  const [hasOmiLink, setHasOmiLink] = useState<boolean>(true);
  const listRef = useRef<FlatList<MessageItem> | null>(null);
  const windowsPollRef = useRef<any>(null);
  const isSmall = width <= 375; // iPhone SE width
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true);
  const loadingOlderRef = useRef<boolean>(false);
  const [olderLoading, setOlderLoading] = useState<boolean>(false);

  const selectedMessages = useMemo(() => {
    if (!selectedId) return [] as MessageItem[];
    const entry = messages.byConversationId[selectedId];
    return (entry?.items || []).slice().sort((a: MessageItem, b: MessageItem) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [messages, selectedId]);

  async function ensureActiveConversation(): Promise<void> {
    try {
      const windows = await apiListWindows();
      let active = windows.find((w: any) => w.isActive && w.conversationId);
      if (!active || !active.conversationId) {
        await apiActivateWindow(1);
        const windows2 = await apiListWindows();
        active = windows2.find((w: any) => w.isActive && w.conversationId);
      }
      if (active?.conversationId) setSelectedId(active.conversationId);
    } catch {}
  }

  // Load the newest page and merge in any new items (limit 20)
  async function loadLatest(conversationId: string, opts?: { reset?: boolean }) {
    setMessages((prev: MessageState) => ({
      byConversationId: {
        ...prev.byConversationId,
        [conversationId]: {
          items: prev.byConversationId[conversationId]?.items || [],
          nextCursor: prev.byConversationId[conversationId]?.nextCursor || null,
          loading: true
        }
      }
    }));
    const res = await apiListMessages(conversationId, 20);
    setMessages((prev: MessageState) => {
      const existing = opts?.reset ? [] : (prev.byConversationId[conversationId]?.items || []);
      const map = new Map<string, MessageItem>();
      [...existing, ...res.items].forEach((m) => map.set(m.id, m));
      const merged = Array.from(map.values());
      return {
        byConversationId: {
          ...prev.byConversationId,
          [conversationId]: { items: merged, nextCursor: res.nextCursor, loading: false }
        }
      };
    });
  }

  // Load older messages and prepend to existing list
  async function loadOlder(conversationId: string) {
    if (loadingOlderRef.current) return;
    const entry = messages.byConversationId[conversationId];
    const cursor = entry?.nextCursor;
    if (!cursor) return;
    loadingOlderRef.current = true;
    setOlderLoading(true);
    try {
      const res = await apiListMessages(conversationId, 20, cursor);
      setMessages((prev: MessageState) => {
        const current = prev.byConversationId[conversationId]?.items || [];
        const map = new Map<string, MessageItem>();
        [...res.items, ...current].forEach((m) => map.set(m.id, m));
        const merged = Array.from(map.values());
        return {
          byConversationId: {
            ...prev.byConversationId,
            [conversationId]: { items: merged, nextCursor: res.nextCursor, loading: false }
          }
        };
      });
    } finally {
      loadingOlderRef.current = false;
      setOlderLoading(false);
    }
  }

  useEffect(() => { 
    (async () => {
      await ensureActiveConversation();
      const me = await apiMe();
      const verified = (me?.omi_links || []).some((l: any) => l.isVerified);
      setHasOmiLink(!!verified);
    })();
    if (windowsPollRef.current) clearInterval(windowsPollRef.current);
    windowsPollRef.current = setInterval(ensureActiveConversation, 10000);
    return () => { if (windowsPollRef.current) clearInterval(windowsPollRef.current); };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    loadLatest(selectedId, { reset: true });
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(() => {
      // Poll only the latest page and merge in
      loadLatest(selectedId);
    }, 5000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [selectedId]);

  const scrollToBottom = (animated: boolean = true) => {
    try {
      const refAny: any = listRef.current as any;
      if (!refAny) return;
      if (typeof refAny.scrollToEnd === 'function') {
        refAny.scrollToEnd({ animated });
      } else if (typeof refAny.scrollToIndex === 'function') {
        const count = selectedMessages.length;
        if (count > 0) refAny.scrollToIndex({ index: count - 1, animated });
      }
    } catch {}
  };

  useEffect(() => {
    // Auto-scroll only when switching chats
    if (!selectedId) return;
    const timer = setTimeout(() => scrollToBottom(true), 50);
    return () => clearTimeout(timer);
  }, [selectedId]);

  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (!selectedId) return;
    if (sendingGuardRef.current) return; // guard against rapid double-taps
    const now = Date.now();
    if (lastSentRef.current && (now - lastSentRef.current.ts) < 1200 && lastSentRef.current.text === text) {
      return;
    }
    sendingGuardRef.current = true;
    setSending(true);

    // Slash commands
    if (text.startsWith('/')) {
      const cmd = text.slice(1).trim();
      if (cmd.startsWith('notify ')) {
        const ok = await apiCreateFollowup({ conversation_id: selectedId, message: cmd.slice('notify '.length) });
        setSending(false);
        sendingGuardRef.current = false;
        setInput('');
        return;
      }
      if (cmd.startsWith('space ')) {
        await apiSwitchSpace(cmd.slice('space '.length).trim());
        setSending(false);
        sendingGuardRef.current = false;
        setInput('');
        return;
      }
      if (cmd.startsWith('window ')) {
        const num = parseInt(cmd.slice('window '.length).trim(), 10);
        if (!isNaN(num)) await apiActivateWindow(num);
        setSending(false);
        sendingGuardRef.current = false;
        setInput('');
        return;
      }
      if (cmd.startsWith('mem ')) {
        await apiCreateMemory(cmd.slice('mem '.length).trim());
        setSending(false);
        sendingGuardRef.current = false;
        setInput('');
        return;
      }
      if (cmd.startsWith('task ')) {
        await apiCreateTask(cmd.slice('task '.length).trim());
        setSending(false);
        sendingGuardRef.current = false;
        setInput('');
        return;
      }
    }

    // Optimistic add user message
    const optimistic: MessageItem = {
      id: `local-${Date.now()}`,
      role: 'USER',
      text,
      source: 'FRONTEND',
      createdAt: new Date().toISOString()
    };
    setMessages((prev: MessageState) => ({
      byConversationId: {
        ...prev.byConversationId,
        [selectedId]: {
          items: [...(prev.byConversationId[selectedId]?.items || []), optimistic],
          nextCursor: prev.byConversationId[selectedId]?.nextCursor || null,
          loading: false
        }
      }
    }));
    setInput('');
    // Keep view pinned to newest message when user sends
    scrollToBottom(false);

    const res = await apiSendMessage({ conversation_id: selectedId, text });
    setSending(false);
    sendingGuardRef.current = false;
    lastSentRef.current = { text, ts: Date.now() };
    if (!res) return;
    // Remove the optimistic message to avoid duplicates, server will return canonical message
    setMessages((prev: MessageState) => {
      const existing = prev.byConversationId[selectedId!]?.items || [];
      const filtered = existing.filter((m) => m.id !== optimistic.id);
      return {
        byConversationId: {
          ...prev.byConversationId,
          [selectedId!]: {
            items: filtered,
            nextCursor: prev.byConversationId[selectedId!]?.nextCursor || null,
            loading: false,
          },
        },
      };
    });
    // Refresh messages to include server message + assistant response
    await loadLatest(selectedId);
  }, [input, sending, selectedId]);

  const renderMessage = ({ item }: { item: MessageItem }) => {
    const isAssistant = item.role === 'ASSISTANT';
    return (
      <View style={[styles.bubbleRow, isAssistant ? styles.left : styles.right]}>
        <View style={[styles.bubble, isAssistant ? styles.assistantBubble : styles.userBubble]}>
          <Text style={isAssistant ? styles.assistantText : styles.userText}>{item.text}</Text>
        </View>
      </View>
    );
  };

  const selectedLoading = selectedId ? messages.byConversationId[selectedId]?.loading : false;

  const onListScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    setIsAtBottom(distanceFromBottom < 80);
    // Auto-load older when near top
    if (contentOffset.y <= 24 && selectedId && !loadingOlderRef.current && messages.byConversationId[selectedId]?.nextCursor) {
      loadOlder(selectedId);
    }
  }, [selectedId, messages]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? (insets.bottom + 50) : 0}>
      <ThemedView style={styles.containerMobile}>
        <View style={styles.headerBar}>
          <Text style={[styles.headerTitle, isSmall && { fontSize: 18 }]}>Chat</Text>
        </View>
        {!hasOmiLink ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>Tip: Link your OMI account in Settings to receive live notifications.</Text>
          </View>
        ) : null}
        {!selectedId ? (
          <View style={styles.emptyState}>
            <ActivityIndicator />
            <Text style={{ marginTop: 8 }}>Preparing conversation…</Text>
          </View>
        ) : (
          <>
            <FlatList<MessageItem>
              ref={listRef}
              style={styles.messageList}
              contentContainerStyle={{ padding: 12, paddingBottom: 12 + Math.max(insets.bottom, 8) }}
              data={selectedMessages}
              renderItem={renderMessage}
              keyExtractor={(m: MessageItem) => m.id}
              onContentSizeChange={() => { if (isAtBottom) scrollToBottom(true); }}
              onScroll={onListScroll}
              scrollEventThrottle={16}
              keyboardShouldPersistTaps="handled"
              maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
              ListHeaderComponent={() => (messages.byConversationId[selectedId!]?.nextCursor ? (
                <View style={{ paddingVertical: 8 }}>{olderLoading ? <ActivityIndicator /> : null}</View>
              ) : null)}
            />
            <View style={[styles.inputRow, { paddingBottom: 8 + Math.max(insets.bottom, 0) }]}>
              <TextInput
                style={[styles.textInput, isSmall && { minHeight: 36, paddingVertical: 6 }]}
                placeholder="Type a message or /notify ..."
                value={input}
                onChangeText={setInput}
                multiline
                onFocus={() => setTimeout(() => scrollToBottom(true), 50)}
              />
              <TouchableOpacity style={styles.sendBtn} onPress={onSend} disabled={sending || !input.trim()}>
                <Text style={styles.sendBtnText}>{sending ? '...' : 'Send'}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row' },
  containerMobile: { flex: 1 },
  sidebar: { width: 240, borderRightWidth: 1, borderRightColor: '#eee', padding: 12, gap: 12 },
  sidebarHeader: { paddingBottom: 8 },
  conversationItem: { paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8 },
  conversationItemActive: { backgroundColor: '#f2f2f2' },
  conversationTitle: { fontWeight: '700' },
  conversationSummary: { color: '#666' },
  chatArea: { flex: 1, paddingTop: 12 },
  headerBar: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#eee' },
  hamburger: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fff' },
  hamburgerText: { fontSize: 18 },
  headerTitle: { fontSize: 20, fontWeight: '800', marginLeft: 12 },
  overlayList: { position: 'absolute', left: 12, top: 56, bottom: 12, width: 280, backgroundColor: '#fff', borderWidth: 1, borderColor: '#eee', borderRadius: 12, padding: 8, zIndex: 20 },
  overlayHeader: { paddingVertical: 6, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#eee', marginBottom: 6 },
  banner: { marginHorizontal: 12, marginBottom: 8, padding: 10, backgroundColor: '#fff7e6', borderColor: '#ffd591', borderWidth: 1, borderRadius: 8 },
  bannerText: { color: '#8c6d1f' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messageList: { flex: 1 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: '#eee' },
  textInput: { flex: 1, minHeight: 40, maxHeight: 140, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  sendBtn: { backgroundColor: '#007bff', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  sendBtnText: { color: '#fff', fontWeight: '700' },
  deleteBtn: { backgroundColor: '#ff4d4f', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, marginLeft: 6 },
  deleteBtnText: { color: '#fff', fontWeight: '700' },
  bubbleRow: { width: '100%', marginVertical: 4, paddingHorizontal: 8 },
  left: { alignItems: 'flex-start' },
  right: { alignItems: 'flex-end' },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 12 },
  assistantBubble: { backgroundColor: '#f0f0f0', borderTopLeftRadius: 2 },
  userBubble: { backgroundColor: '#007bff', borderTopRightRadius: 2 },
  assistantText: { color: '#333' },
  userText: { color: '#fff' },
  badge: { paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: '#ccc', borderRadius: 999 },
  badgeActive: { backgroundColor: '#2f95dc', borderColor: '#2f95dc' },
  badgeText: { color: '#333' },
  badgeTextActive: { color: '#fff' },
});

