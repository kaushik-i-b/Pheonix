package com.fnb.corebank.repo;

import com.fnb.corebank.domain.LedgerEntry;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface LedgerEntryRepository extends JpaRepository<LedgerEntry, Long> {

    List<LedgerEntry> findByAccountIdOrderByIdAsc(Long accountId);
}
