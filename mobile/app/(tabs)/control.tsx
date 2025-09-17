import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, TextInput, FlatList, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageState>({ byConversationId: {} });
  const [input, setInput] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const pollingRef = useRef<any>(null);
  const [hasOmiLink, setHasOmiLink] = useState<boolean>(true);
  const listRef = useRef<FlatList<MessageItem> | null>(null);
  const windowsPollRef = useRef<any>(null);

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

  async function loadMessages(conversationId: string) {
    setMessages((prev: MessageState) => ({
      byConversationId: {
        ...prev.byConversationId,
        [conversationId]: { items: prev.byConversationId[conversationId]?.items || [], nextCursor: prev.byConversationId[conversationId]?.nextCursor || null, loading: true }
      }
    }));
    const res = await apiListMessages(conversationId, 100);
    setMessages((prev: MessageState) => ({
      byConversationId: {
        ...prev.byConversationId,
        [conversationId]: { items: res.items, nextCursor: res.nextCursor, loading: false }
      }
    }));
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
    loadMessages(selectedId);
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(() => {
      loadMessages(selectedId);
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
    // Auto-scroll when switching chats or when new messages arrive
    if (!selectedId) return;
    const timer = setTimeout(() => scrollToBottom(true), 50);
    return () => clearTimeout(timer);
  }, [selectedId, selectedMessages.length]);

  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (!selectedId) return;
    setSending(true);

    // Slash commands
    if (text.startsWith('/')) {
      const cmd = text.slice(1).trim();
      if (cmd.startsWith('notify ')) {
        const ok = await apiCreateFollowup({ conversation_id: selectedId, message: cmd.slice('notify '.length) });
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('space ')) {
        await apiSwitchSpace(cmd.slice('space '.length).trim());
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('window ')) {
        const num = parseInt(cmd.slice('window '.length).trim(), 10);
        if (!isNaN(num)) await apiActivateWindow(num);
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('mem ')) {
        await apiCreateMemory(cmd.slice('mem '.length).trim());
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('task ')) {
        await apiCreateTask(cmd.slice('task '.length).trim());
        setSending(false);
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
    // Keep view pinned to newest message
    scrollToBottom(false);

    const res = await apiSendMessage({ conversation_id: selectedId, text });
    setSending(false);
    if (!res) return;
    // Refresh messages to include assistant response
    await loadMessages(selectedId);
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

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.containerMobile}>
        <View style={styles.headerBar}>
          <Text style={styles.headerTitle}>Chat</Text>
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
              contentContainerStyle={{ padding: 12 }}
              data={selectedMessages}
              renderItem={renderMessage}
              keyExtractor={(m: MessageItem) => m.id}
              onContentSizeChange={() => scrollToBottom(true)}
            />
            <View style={styles.inputRow}>
              <TextInput
                style={styles.textInput}
                placeholder="Type a message or /notify ..."
                value={input}
                onChangeText={setInput}
                multiline
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

